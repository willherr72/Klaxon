//! Bridge from the alarm planner to the Kotlin reconciler. One reconcile,
//! three callers: cold sync pass, warm background pass, and the
//! foreground `reconcile_notifications` command. Failure is logged and
//! never fails the caller — delivering data outranks ringing, and the
//! next reconcile retries naturally.

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::AppResult;

#[cfg(target_os = "android")]
pub fn reconcile_os_alarms(db: &Arc<Mutex<Connection>>) -> AppResult<()> {
    use crate::error::AppError;

    let (plan, live_pairs) = {
        let conn = db.lock();
        let reminders = crate::db::reminders::list_all(&conn)?;
        let armed = crate::db::armed_alarms::armed_set(&conn)?;
        let plan = crate::alarm_plan::desired_notifications(
            &reminders,
            &armed,
            crate::models::now_ms(),
        );
        // Live = the CURRENT fire-target pair of every non-terminal
        // reminder — logged pairs matching these must survive (they're
        // what blocks re-rings), while pairs for moved, completed, or
        // deleted reminders age out. NOT plan ∪ armed: unioning the
        // existing log in would make prune a permanent no-op.
        let live: std::collections::HashSet<(String, i64)> = reminders
            .iter()
            .filter(|r| {
                matches!(
                    r.state,
                    crate::models::ReminderState::Pending
                        | crate::models::ReminderState::Snoozed
                )
            })
            .map(|r| (r.id.clone(), r.snooze_until.unwrap_or(r.due_at)))
            .collect();
        (plan, live)
    };

    let json = serde_json::to_string(&plan)
        .map_err(|e| AppError::Invalid(format!("plan encode: {e}")))?;

    let ok = call_kotlin_reconcile(&json)?;
    if !ok {
        return Err(AppError::Invalid("kotlin reconcile reported failure".into()));
    }

    // Log AFTER Kotlin succeeded — a failed hand-off must not burn a
    // ring-once entry (spec §5). Then prune stale pairs.
    {
        let conn = db.lock();
        let pairs: Vec<(String, i64)> = plan
            .iter()
            .map(|p| (p.reminder_id.clone(), p.at_ms))
            .collect();
        let _ = crate::db::armed_alarms::log_armed(&conn, &pairs, crate::models::now_ms());
        let _ = crate::db::armed_alarms::prune(&conn, &live_pairs);
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn reconcile_os_alarms(_db: &Arc<Mutex<Connection>>) -> AppResult<()> {
    Ok(())
}

/// Classloader-JNI into NotificationReconciler — same pattern as
/// ShareHelper (FindClass on a native thread can't see app classes).
#[cfg(target_os = "android")]
fn call_kotlin_reconcile(plan_json: &str) -> AppResult<bool> {
    use crate::error::AppError;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| AppError::Invalid(format!("jvm: {e}")))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| AppError::Invalid(format!("attach: {e}")))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };

    let loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("classloader: {e}")))?;
    let name = env
        .new_string("com.klaxon.app.NotificationReconciler")
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("loadClass: {e}")))?;

    let jplan = env
        .new_string(plan_json)
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let ok = env
        .call_static_method(
            jni::objects::JClass::from(class),
            "reconcile",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[(&context).into(), (&jplan).into()],
        )
        .and_then(|v| v.z())
        .map_err(|e| AppError::Invalid(format!("reconcile call: {e}")))?;
    Ok(ok)
}
