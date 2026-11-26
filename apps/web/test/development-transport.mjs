import assert from 'node:assert/strict';

export const deployment = 'https://klaxon-browser-test.convex.cloud';
const issuedAt = Math.floor(Date.now() / 1_000);

function accessToken(generation) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ sub: generation, iat: issuedAt, exp: issuedAt + 3_600 }),
    Buffer.from('synthetic-signature').toString('base64url'),
  ].join('.');
}

const tokens = {
  userId: 'test-user',
  accessToken: accessToken('initial-session'),
  refreshToken: 'inert-browser-refresh',
  refreshTokenExpiresAt: 2200000000000,
};
const rotatedTokens = {
  ...tokens, accessToken: accessToken('rotated-session'), refreshToken: 'inert-rotated-refresh',
};
const workspace = {
  _id: 'personal-workspace', _creationTime: 1, publicId: 'personal-public', ownerId: tokens.userId,
  name: 'Personal', revision: 1, createdAt: 1, updatedAt: 1,
};
const otherTokens = {
  ...tokens, userId: 'other-user', accessToken: accessToken('other-session'), refreshToken: 'inert-other-refresh',
};
const otherWorkspace = {
  ...workspace, _id: 'other-personal-workspace', publicId: 'other-personal-public', ownerId: otherTokens.userId,
};

export function task(publicId, title, status = 'inbox', revision = 4) {
  return {
    _id: 'task-' + publicId, _creationTime: 1, workspaceId: workspace._id,
    publicId, title, status, revision, createdAt: 1, updatedAt: revision,
    rank: 1, priority: 'none', source: { kind: 'manual' },
  };
}

export function capture(publicId, body, source = { kind: 'manual' }) {
  return {
    _id: 'capture-' + publicId, _creationTime: 1, workspaceId: workspace._id,
    publicId, body, source, tags: [], revision: 1, createdAt: 1, updatedAt: 1,
  };
}

function messages() {
  const queue = [];
  let receive;
  return {
    push(value) {
      if (!receive) queue.push(value);
      else {
        const next = receive;
        receive = undefined;
        next(value);
      }
    },
    async next() {
      if (queue.length) return queue.shift();
      const { promise, resolve, reject } = Promise.withResolvers();
      receive = resolve;
      const timeout = setTimeout(() => reject(new Error('Missing Convex request')), 5_000);
      try {
        return await promise;
      } finally {
        clearTimeout(timeout);
        receive = undefined;
      }
    },
  };
}

function timestamp(tick) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(tick));
  return bytes.toString('base64');
}

export async function interceptDevelopment(context, t, entry) {
  const unexpected = [];
  const sockets = new Set();
  const queryAdded = messages();
  const taskRequested = messages();
  const writes = messages();
  const captureQueries = messages();
  const captureWrites = messages();
  const agendaRequested = messages();
  const upcomingRequested = messages();
  let currentTokens = tokens;
  let personal = workspace;
  let ownerWorkspace = workspace;
  let rotationRequested = false;
  const fixture = {
    sockets, queryAdded, taskRequested, writes, captureQueries, captureWrites, agendaRequested, upcomingRequested,
    signOuts: 0, httpRequests: 0,
  };
  t.after(() => assert.deepEqual(unexpected, [], 'unexpected Convex traffic'));

  await context.route('**/*', async route => {
    const request = route.request();
    if (request.url().startsWith(entry)) return route.continue();
    if (request.url() !== deployment + '/api/mutation' || request.method() !== 'POST') {
      unexpected.push('unexpected HTTP request');
      return route.abort();
    }
    fixture.httpRequests++;
    const body = request.postDataJSON();
    const [args] = body.args;
    assert.equal(body.format, 'convex_encoded_json');
    let value;
    switch (body.path) {
      case 'auth:signInWithUsernamePassword':
        assert.equal(request.headers().authorization, undefined);
        if (args.password === 'inert-password' && ['test-owner', 'test-other'].includes(args.username)) {
          currentTokens = args.username === 'test-owner' ? tokens : otherTokens;
          personal = args.username === 'test-owner' ? ownerWorkspace : otherWorkspace;
          value = { status: 'complete', tokens: currentTokens };
        } else {
          value = { status: 'error', userError: { error: 'INVALID_CREDENTIALS' } };
        }
        break;
      case 'auth:refreshSession':
        assert.deepEqual(args, { refreshToken: currentTokens.refreshToken });
        if (rotationRequested) {
          rotationRequested = false;
          currentTokens = rotatedTokens;
          value = { kind: 'rotated', tokens: currentTokens };
        } else value = { kind: 'noSession' };
        break;
      case 'auth:signOut':
        assert.deepEqual(args, { refreshToken: currentTokens.refreshToken });
        fixture.signOuts++;
        value = null;
        break;
      default:
        unexpected.push('unexpected HTTP mutation');
        return route.abort();
    }
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { status: 'success', value, logLines: [] },
    });
  });

  await context.routeWebSocket('**/*', socket => {
    if (socket.url() !== 'wss://klaxon-browser-test.convex.cloud/api/1.51.0/sync') {
      unexpected.push('unexpected socket destination or SDK version');
      void socket.close();
      return;
    }
    let version = { querySet: 0, identity: 0, ts: timestamp(0) };
    let tick = 0;
    let authenticated = false;
    const queries = new Set();
    const taskQueries = new Set();
    const captures = new Set();
    const send = message => socket.send(JSON.stringify(message));
    function transition(modifications = [], changes = {}) {
      const startVersion = version;
      version = { ...version, ...changes, ts: timestamp(++tick) };
      send({ type: 'Transition', startVersion, endVersion: version, modifications });
    }
    function publish(subscribers, page, cursor) {
      transition(Array.from(subscribers, queryId => ({
        type: 'QueryUpdated', queryId, value: { page, isDone: cursor === undefined, continueCursor: cursor ?? 'end' },
        journal: null, logLines: [],
      })));
    }
    const connection = {
      queries, captures,
      publish: (page, cursor) => publish(queries, page, cursor),
      publishCaptures: (page, cursor) => publish(captures, page, cursor),
      failRead: () => transition(Array.from(queries, queryId => ({
        type: 'QueryFailed', queryId, errorMessage: 'Synthetic query failure', journal: null, logLines: [],
      }))),
      expire: () => send({ type: 'AuthError', error: 'Expired', baseVersion: version.identity, authUpdateAttempted: false }),
    };
    sockets.add(connection);
    socket.onClose((code, reason) => {
      // A routed socket needs the close acknowledgment before the SDK can reconnect.
      if (sockets.delete(connection)) void socket.close({ code, reason });
    });
    socket.onMessage(raw => {
      try {
        const message = JSON.parse(raw);
        switch (message.type) {
          case 'Connect':
          case 'Event':
            break;
          case 'Authenticate':
            assert.equal(message.baseVersion, version.identity);
            assert.equal(message.tokenType, 'User');
            assert.equal(message.value, currentTokens.accessToken);
            authenticated = true;
            transition([], { identity: message.baseVersion + 1 });
            break;
          case 'ModifyQuerySet': {
            assert.ok(authenticated);
            assert.equal(message.baseVersion, version.querySet);
            const updates = [];
            for (const modification of message.modifications) {
              const { queryId } = modification;
              if (modification.type === 'Remove') {
                assert.ok(queries.delete(queryId) || taskQueries.delete(queryId) || captures.delete(queryId));
                updates.push({ type: 'QueryRemoved', queryId });
              } else if (modification.udfPath === 'tasks:get') {
                taskQueries.add(queryId);
                taskRequested.push({
                  args: modification.args[0],
                  respond: value => transition([{ type: 'QueryUpdated', queryId, value, journal: null, logLines: [] }]),
                });
              } else if (['captures:list', 'captures:search'].includes(modification.udfPath)) {
                const [args] = modification.args;
                assert.equal(args.workspaceId, personal._id);
                assert.equal(modification.udfPath === 'captures:search', typeof args.text === 'string');
                captures.add(queryId);
                captureQueries.push({ args });
              } else if (modification.udfPath === 'activity:list') {
                assert.equal(modification.args[0].workspaceId,personal._id);
                taskQueries.add(queryId);
                updates.push({type:'QueryUpdated',queryId,journal:null,logLines:[],value:{page:[{
                  eventId:'event-local',actor:'You',origin:'app',action:'task.update',createdAt:1700000000000,
                  targetKind:'task',targetPublicId:'primer-id',revision:2,undoEligible:true,
                }],isDone:true,continueCursor:'end'}});
              } else if (modification.udfPath === 'organization:search') {
                const [args] = modification.args;
                assert.equal(args.workspaceId,personal._id);
                taskQueries.add(queryId);
                const tasks = args.text === 'primer' ? [task('primer-id','Review primer')] : [];
                updates.push({type:'QueryUpdated',queryId,journal:null,logLines:[],value:{tasks,notes:[],partial:false}});
              } else if (modification.udfPath === 'agenda:today') {
                const [args] = modification.args;
                assert.equal(args.workspaceId, personal._id);
                taskQueries.add(queryId);
                agendaRequested.push({
                  args,
                  respond(sections) {
                    const section = name => ({ items: sections[name] ?? [], partial: false });
                    transition([{
                      type: 'QueryUpdated', queryId, journal: null, logLines: [],
                      value: {
                        localDate: args.localDate, timezone: args.timezone, needsReplan: false, focus: section('focus'),
                        planned: section('planned'), overdue: section('overdue'), dueToday: section('dueToday'),
                        followUps: section('followUps'), unplanned: section('unplanned'),
                      },
                    }]);
                  },
                });
              } else if (modification.udfPath === 'agenda:upcoming') {
                const [args] = modification.args;
                assert.equal(args.workspaceId, personal._id);
                taskQueries.add(queryId);
                upcomingRequested.push({
                  args,
                  respond(items) {
                    const until = new Date(`${args.from}T00:00:00Z`);
                    until.setUTCDate(until.getUTCDate() + 7);
                    transition([{
                      type: 'QueryUpdated', queryId, journal: null, logLines: [],
                      value: { from: args.from, timezone: args.timezone, until: until.toISOString().slice(0, 10), items, partial: false },
                    }]);
                  },
                });
              } else if (['projects:list', 'steps:list', 'links:list', 'calendar:list', 'planning:getPreferences','planning:getDayPlan'].includes(modification.udfPath)
                  || (fixture.calendarTray && modification.udfPath === 'tasks:list')) {
                const [args] = modification.args;
                assert.equal(args.workspaceId, personal._id);
                taskQueries.add(queryId);
                const emptyPages = {
                  'calendar:list': {localDate:args.localDate,timezone:'UTC',startAt:Date.parse(args.localDate+'T00:00Z'),
                    endAt:Date.parse(args.localDate+'T00:00Z') + 86_400_000,blocks:[],events:[]},
                  'planning:getPreferences': {timezone:'UTC',revision:0,workHours:[],breaks:[],bufferMinutes:0,
                    discretionaryMinutes:0,lockManuallyMovedBlocks:true},
                  'planning:getDayPlan': null,
                };
                const value = Object.hasOwn(emptyPages,modification.udfPath) ? emptyPages[modification.udfPath]
                  : { page: [], isDone: true, continueCursor: 'end' };
                updates.push({ type: 'QueryUpdated', queryId, value, journal: null, logLines: [] });
              } else {
                assert.equal(modification.udfPath, 'tasks:list');
                queries.add(queryId);
                queryAdded.push({ args: modification.args[0] });
              }
            }
            assert.ok(queries.size <= 1, 'only one page should remain subscribed');
            assert.ok(captures.size <= 1, 'only one capture page should remain subscribed');
            transition(updates, { querySet: message.newVersion });
            break;
          }
          case 'Mutation': {
            assert.ok(authenticated);
            const common = { type: 'MutationResponse', requestId: message.requestId, logLines: [] };
            function succeed(result) {
              send({ ...common, success: true, result, ts: timestamp(tick + 1) });
            }
            const [args] = message.args;
            if (message.udfPath === 'activity:undo') {
              assert.equal(args.eventId,'event-local');
              assert.equal(args.expectedRevision,2);
              send({type:'MutationResponse',requestId:message.requestId,success:false,
                result:'Task changed',errorData:{code:'REVISION_CONFLICT',currentRevision:3},logLines:[]});
            } else if (message.udfPath === 'workspaces:ensurePersonal') {
              assert.deepEqual(args, {});
              succeed(personal);
              transition();
            } else {
              const isCapture = message.udfPath === 'captures:apply';
              if (!isCapture) assert.equal(message.udfPath, 'tasks:apply');
              assert.equal(args.workspaceId, personal._id);
              const queue = isCapture ? captureWrites : writes;
              queue.push({
                args,
                fail(errorData) {
                  send({ ...common, success: false, result: 'Synthetic mutation failure', errorData });
                },
                succeed(page = []) {
                  succeed({
                    workspacePublicId: personal.publicId, targetPublicId: args.command.publicId,
                    revision: page.find(row => row.publicId === args.command.publicId)?.revision ?? 1,
                    activityEventId: 'activity-event',
                  });
                  publish(isCapture ? captures : queries, page);
                },
              });
            }
            break;
          }
          default:
            throw new Error('unexpected socket message type: ' + message.type);
        }
      } catch (error) {
        unexpected.push(error.message);
        void socket.close();
      }
    });
  });

  return Object.assign(fixture, {
    activeQueries: () => Array.from(sockets).reduce((sum, socket) => sum + socket.queries.size, 0),
    publish: (...args) => { for (const socket of sockets) socket.publish(...args); },
    publishCaptures: (...args) => { for (const socket of sockets) socket.publishCaptures(...args); },
    failRead: () => { for (const socket of sockets) socket.failRead(); },
    changeOwnerWorkspace: () => {
      ownerWorkspace = { ...workspace, _id: 'replacement-workspace', publicId: 'replacement-public' };
    },
    restoreOwnerWorkspace: () => { ownerWorkspace = workspace; },
    rotate: () => {
      rotationRequested = true;
      for (const socket of sockets) socket.expire();
    },
    expire: () => { for (const socket of sockets) socket.expire(); },
  });
}
