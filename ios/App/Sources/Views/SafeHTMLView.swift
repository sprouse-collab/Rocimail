import SwiftUI
import WebKit

/// T4.4 — locked-down HTML mail rendering:
/// - JavaScript disabled
/// - remote loads blocked by CSP (remote images off by default; a per-message
///   "load images" toggle arrives with the blob-backed cid: pipeline in M1)
/// - link taps never navigate in-place; they open in the system browser
///   after leaving the app (SFSafariViewController confirmation lands in M1)
struct SafeHTMLView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastHTML != html else { return }
        context.coordinator.lastHTML = html
        webView.loadHTMLString(Self.wrap(html), baseURL: nil)
    }

    /// Wrap the message body with a restrictive CSP and readable defaults.
    static func wrap(_ body: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:;">
        <style>
          body {
            font: -apple-system-body;
            font-family: -apple-system, sans-serif;
            margin: 16px;
            color: CanvasText;
            background: Canvas;
            color-scheme: light dark;
            word-wrap: break-word;
          }
          img { max-width: 100%; height: auto; }
          pre, table { max-width: 100%; overflow-x: auto; display: block; }
          blockquote {
            margin: 0 0 0 8px;
            padding-left: 10px;
            border-left: 3px solid #d83a34;
            color: color-mix(in srgb, CanvasText 70%, Canvas);
          }
          a { color: #d83a34; }
        </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastHTML: String?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Only the initial loadHTMLString may proceed; every link tap is
            // routed out of the sandboxed view.
            guard navigationAction.navigationType == .linkActivated else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if let url = navigationAction.request.url,
               url.scheme == "https" || url.scheme == "http" {
                UIApplication.shared.open(url)
            }
        }
    }
}
