// ストーリー坊ちゃん iPad アプリ
//
// 公開しているWeb版（GitHub Pages）を、Safari の枠なしで画面いっぱいに表示するだけの小さなアプリ。
// - 中身はWeb版そのものなので、Web版を push して更新すれば、このアプリも次に開いたときに新しくなる（作り直し不要）。
// - 一度開けば、Web版の Service Worker のおかげでネットがなくても開ける（App-Bound Domains で有効にしている）。
// - Web版の「💾 保存」「📄 PDF」のファイルは、iPad の共有シート（「ファイル」に保存・AirDrop など）で受け取る。
// - 作品はこのアプリの中に保存される（Safari で使った作品とは別。移すときは「💾 保存」のzipで）。

import SwiftUI

enum AppConfig {
    /// 表示するWeb版のURL（ここを変えると別の公開先を開く）
    /// 起動時の引数 -startURL で別のURLを開ける（例：調べものに ?debug=1 を付ける）
    static let startURL: URL = {
        if let s = UserDefaults.standard.string(forKey: "startURL"), let u = URL(string: s) { return u }
        return URL(string: "https://hakenlabo.github.io/StoryBocchan/")!
    }()
    /// アプリの中だけで開くドメイン（Info.plist の WKAppBoundDomains と同じにする）
    static let appHost = "hakenlabo.github.io"
}

@main
struct StoryBocchanApp: App {
    var body: some Scene {
        WindowGroup {
            WebView(url: AppConfig.startURL)
                .ignoresSafeArea(.container, edges: [.bottom, .horizontal])
                .background(Color(red: 0.93, green: 0.94, blue: 0.95))
                .statusBarHidden(false)
        }
    }
}
