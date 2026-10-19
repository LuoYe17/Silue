// release 版在 Windows 上不弹出额外的命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    silue_lib::run()
}
