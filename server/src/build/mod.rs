pub mod mdx;
pub mod pdx;

pub(super) fn failure(message: impl ToString) -> serde_json::Value {
    serde_json::json!({ "ok": false, "message": message.to_string() })
}
