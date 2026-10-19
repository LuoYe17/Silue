// 密钥存进系统安全存储（Windows 凭据管理器），不进 SQLite。
// shortcut: keyring 的经典接口不支持 iOS，做 iOS 时改用 keyring-core + apple-native-keyring-store
const KEYRING_SERVICE: &str = "io.github.luoye17.silue";

/// 读一个密钥，没存过返回 None
#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 存一个密钥，空字符串表示删除
#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &name).map_err(|e| e.to_string())?;
    let result = if value.is_empty() {
        match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        }
    } else {
        entry.set_password(&value)
    };
    result.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 表结构和迁移在 core 的 DocStore 里（TypeScript），这里只提供 SQLite 连接
        .plugin(tauri_plugin_sql::Builder::default().build())
        // 模型请求从 Rust 端发：不受 WebView 的跨域限制，中转站不用配 CORS
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![secret_get, secret_set])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
