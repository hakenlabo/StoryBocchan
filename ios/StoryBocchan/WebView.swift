// Web版を表示する WKWebView と、ファイルの保存（ダウンロード）の受け取り。

import SwiftUI
import UIKit
import WebKit

struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(startURL: url) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // App-Bound Domains に限ると、Service Worker（オフラインで開ける仕組み）が使える
        // （調べもので別のURL、たとえば手元のサーバーを開くときは制限しない）
        config.limitsNavigationsToAppBoundDomains = (url.host == AppConfig.appHost)
        config.websiteDataStore = .default()          // 作品（IndexedDB）をアプリの中に残す
        config.allowsInlineMediaPlayback = true
        // Web版のエラーやログを、アプリのログ（Xcode のコンソール）に出す（調べものをしやすくするため）
        let bridge = """
        (function () {
          function send(level, args) {
            try { window.webkit.messageHandlers.log.postMessage(level + ': ' + Array.prototype.map.call(args, function (a) {
              return (a && a.stack) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' ')); } catch (e) {}
          }
          ['error', 'warn', 'log'].forEach(function (k) {
            var orig = console[k];
            console[k] = function () { send(k, arguments); return orig.apply(console, arguments); };
          });
          window.addEventListener('error', function (e) { send('uncaught', [e.message + ' @' + e.filename + ':' + e.lineno]); });
          window.addEventListener('unhandledrejection', function (e) { send('unhandled', [e.reason]); });
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(context.coordinator, name: "log")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false   // 端からのスワイプで「戻る」にならないように
        web.allowsLinkPreview = false
        // ページそのものは動かさない・拡大しない（マップや絵の操作はWeb版の中で扱う）
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        if #available(iOS 16.4, *) { web.isInspectable = true } // Mac の Safari から中身を調べられる
        context.coordinator.webView = web
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    // MARK: -

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        let startURL: URL
        private var downloadFiles: [ObjectIdentifier: URL] = [:]

        init(startURL: URL) { self.startURL = startURL }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            NSLog("[web] %@", String(describing: message.body))
        }

        // ---- 移動の判断 ----
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // <a download>（「💾 保存」のzip・PDF）はダウンロードとして受け取る
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            // ほかのサイトへのリンクは Safari で開く
            if let u = navigationAction.request.url, let host = u.host,
               host != AppConfig.appHost, host != startURL.host, u.scheme == "https" || u.scheme == "http" {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        }

        // 初めて開くときにネットにつながっていない
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let html = """
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{font-family:-apple-system,'Hiragino Sans';background:#eef0f3;color:#23262b;display:flex;
            align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
            button{font-size:18px;padding:10px 24px;border-radius:10px;border:0;background:#2f6fde;color:#fff}</style></head>
            <body><div><h2>ストーリー坊ちゃんを開けませんでした</h2>
            <p>はじめて開くときはインターネットが必要です。<br>一度開けば、次からはネットがなくても使えます。</p>
            <button onclick="location.href='\(startURL.absoluteString)'">もう一度開く</button></div></body></html>
            """
            webView.loadHTMLString(html, baseURL: startURL)
        }

        // ---- ダウンロード（保存） ----
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(suggestedFilename)
            try? FileManager.default.removeItem(at: dest)
            downloadFiles[ObjectIdentifier(download)] = dest
            completionHandler(dest)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
            DispatchQueue.main.async { self.share(file) }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloadFiles.removeValue(forKey: ObjectIdentifier(download))
            alert("保存できませんでした", error.localizedDescription)
        }

        /// iPad の共有シートを出す（「ファイル」に保存・AirDrop など）
        private func share(_ file: URL) {
            guard let web = webView, let top = Self.topViewController() else { return }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = web
                pop.sourceRect = CGRect(x: web.bounds.midX, y: 60, width: 1, height: 1)
                pop.permittedArrowDirections = [.up]
            }
            top.present(sheet, animated: true)
        }

        // ---- alert / confirm（Web版が使ったとき用） ----
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            Self.topViewController()?.present(a, animated: true) ?? completionHandler()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            Self.topViewController()?.present(a, animated: true) ?? completionHandler(false)
        }

        // target="_blank" などで新しい窓を開こうとしたら、同じ画面で開く
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
            return nil
        }

        private func alert(_ title: String, _ message: String) {
            DispatchQueue.main.async {
                let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "OK", style: .default))
                Self.topViewController()?.present(a, animated: true)
            }
        }

        private static func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
            while let next = top?.presentedViewController { top = next }
            return top
        }
    }
}
