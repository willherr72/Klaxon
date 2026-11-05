use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{json, Value};

pub fn definitions() -> Vec<Tool> {
    let text = || json!({"type":"string","maxLength":10000});
    let id = || json!({"type":"string","minLength":1,"maxLength":128});
    let time = || json!({"type":"string","description":"RFC3339 timestamp with explicit UTC offset, e.g. 2026-11-06T09:00:00-06:00. Resolve the user's local date and timezone first."});
    let tags = || json!({"type":"array","items":{"type":"string","maxLength":80},"maxItems":50});
    let priority = || json!({"type":"string","enum":["low","normal","high"]});
    let rule = || json!({"anyOf":[{"type":"null"},{"type":"object","properties":{"kind":{"const":"daily"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"weekly"},"weekdays":{"type":"array","items":{"type":"integer","minimum":0,"maximum":6},"minItems":1,"maxItems":7}},"required":["kind","weekdays"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"interval"},"every_seconds":{"type":"integer","minimum":60}},"required":["kind","every_seconds"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"monthly"},"day":{"type":"integer","minimum":1,"maximum":31}},"required":["kind","day"],"additionalProperties":false}]});
    let patch = json!({"type":"object","properties":{"title":text(),"description":text(),"due_at":time(),"priority":priority(),"tags":tags(),"repeat_rule":rule()},"additionalProperties":false,"minProperties":1});
    let mut tools = vec![];
    let mut add = |name: &str,
                   description: &str,
                   mut props: Value,
                   required: &[&str],
                   write: bool| {
        let mut required: Vec<Value> = required.iter().map(|s| json!(s)).collect();
        if write {
            props["operation_id"] = json!({"type":"string","description":"New UUID for this request. Retrying an identical request with the same UUID returns its original result."});
            props["expected_revision"] = json!({"type":"string","description":"Revision returned by the most recent read or write. Conflicts require rereading and a new operation ID."});
            required.extend([json!("operation_id"), json!("expected_revision")]);
        }
        let schema = json!({"type":"object","properties":props,"required":required,"additionalProperties":false});
        let mut tool = Tool::new(
            name.to_owned(),
            description.to_owned(),
            schema.as_object().unwrap().clone(),
        );
        tool.annotations = Some(
            ToolAnnotations::new()
                .read_only(!write)
                .destructive(
                    write
                        && ![
                            "create_task",
                            "create_reminder",
                            "create_thought",
                            "add_step",
                        ]
                        .contains(&name),
                )
                .idempotent(true)
                .open_world(false),
        );
        tools.push(tool);
    };
    let paging = json!({"offset":{"type":"integer","minimum":0,"maximum":100000},"limit":{"type":"integer","minimum":1,"maximum":50}});
    add("get_planning_context","Read unfinished tasks with their ordered steps, reminders, lanes and today's note. Follow next_offset for more. Suggest work using IDs and reasons; a planning question does not authorize edits.",paging.clone(),&[],false);
    add(
        "get_item",
        "Read a task with steps, reminder, thought, or step and a fresh revision.",
        json!({"kind":{"type":"string","enum":["task","reminder","thought","step"]},"id":id()}),
        &["kind", "id"],
        false,
    );
    add(
        "get_day_note",
        "Read a calendar note.",
        json!({"day":text()}),
        &["day"],
        false,
    );
    let mut search = paging;
    search["query"] = text();
    add(
        "search_thoughts",
        "Search the thought inbox explicitly; returns bounded full-text matches.",
        search,
        &["query"],
        false,
    );
    add(
        "create_task",
        "Create a silent task. due_at is optional; no alarm is scheduled.",
        json!({"title":text(),"description":text(),"due_at":time(),"priority":priority(),"tags":tags(),"lane_id":id()}),
        &["title"],
        true,
    );
    add(
        "create_reminder",
        "Create a real ringing reminder after resolving the user's date and time zone.",
        json!({"title":text(),"description":text(),"due_at":time(),"priority":priority(),"tags":tags(),"repeat_rule":rule()}),
        &["title", "due_at"],
        true,
    );
    for name in ["update_task", "update_reminder"] {
        add(
            name,
            "Update the specified fields. Reread if the revision is stale.",
            json!({"id":id(),"patch":patch}),
            &["id", "patch"],
            true,
        );
    }
    add("move_task","Place a task in a lane between above_id (card above) and below_id (card below). Omit neighbors to move to the top.",json!({"id":id(),"lane_id":id(),"above_id":id(),"below_id":id()}),&["id","lane_id"],true);
    add(
        "complete_task",
        "Complete a task while preserving its steps and their completion history.",
        json!({"id":id()}),
        &["id"],
        true,
    );
    add(
        "snooze_reminder",
        "Snooze an existing reminder to a resolved future timestamp.",
        json!({"id":id(),"until":time()}),
        &["id", "until"],
        true,
    );
    add(
        "create_thought",
        "Capture a thought in the ordinary searchable inbox.",
        json!({"body":text(),"tags":tags()}),
        &["body"],
        true,
    );
    add(
        "update_thought",
        "Edit a thought's body or tags.",
        json!({"id":id(),"patch":{"type":"object","properties":{"body":text(),"tags":tags()},"additionalProperties":false,"minProperties":1}}),
        &["id", "patch"],
        true,
    );
    add("set_day_note","Replace the note for YYYY-MM-DD. Read the existing note first; preserve content the user did not ask to change.",json!({"day":text(),"body":text()}),&["day","body"],true);
    add(
        "add_step",
        "Append an ordered step to an existing task.",
        json!({"task_id":id(),"title":{"type":"string","minLength":1,"maxLength":500}}),
        &["task_id", "title"],
        true,
    );
    add(
        "update_step",
        "Edit a step title or completion. Completing steps does not complete the parent task.",
        json!({"id":id(),"title":{"type":"string","minLength":1,"maxLength":500},"completed":{"type":"boolean"}}),
        &["id"],
        true,
    );
    add(
        "move_step",
        "Move a step before another step in the same task. Omit before_id to append.",
        json!({"id":id(),"before_id":id()}),
        &["id"],
        true,
    );
    tools
}
