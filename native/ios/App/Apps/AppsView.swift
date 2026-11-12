import LatchNativeCore
import SwiftUI

/** 应用: the plugin pages applied on this computer. The App lists them and says plainly that it cannot show them yet. */
struct AppsTabView: View {
    @EnvironmentObject private var model: PhoneModel
    private var selection: Binding<String?> {
        Binding(get: { model.appPath.first }, set: { model.appPath = $0.map { [$0] } ?? [] })
    }
    var body: some View {
        let pages = PhoneApps.listed(model.snapshot)
        NavigationSplitView {
            List(selection: selection) {
                ForEach(pages) { page in
                    HStack(spacing: 12) {
                        AppIcon(name: page.icon)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(page.title).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                            Text(page.plugin).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                        }
                    }.padding(.vertical, 4).tag(page.id)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20)).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(PhoneTheme.canvas)
            .navigationTitle("应用").navigationBarTitleDisplayMode(.large)
        } detail: {
            if let id = model.appPath.first {
                if let page = pages.first(where: { $0.id == id }) { AppPageView(page: page) }
                else {
                    VStack(spacing: 12) {
                        Text("找不到这个页面").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                        Button("回到应用") { model.appPath = [] }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
                }
            } else { PhoneTheme.canvas.ignoresSafeArea() }
        }
    }
}

/** No plugin code is loaded and no web view opens: the page is the web's to show. */
private struct AppPageView: View {
    let page: PhoneAppEntry
    var body: some View {
        VStack(spacing: 14) {
            AppIcon(name: page.icon, size: 52)
            Text(page.title).font(.system(size: 20, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
            Text(page.plugin).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            HStack(spacing: 6) {
                Text("尚未实现：原生 App 还不能显示插件页面").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink2).multilineTextAlignment(.center)
                HintButton(label: "在哪里使用", text: "在手机浏览器打开这台电脑的 Latch 可以使用这个页面。")
            }.padding(.top, 8)
        }
        .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
        .navigationTitle(page.title).navigationBarTitleDisplayMode(.inline)
    }
}

/** The page's icon by the plugin's own name for it, or the neutral grid. */
struct AppIcon: View {
    let name: String?
    var size: CGFloat = 36
    private static let symbols: [String: String] = [
        "list-checks": "checklist", "layout-grid": "square.grid.2x2", "calendar": "calendar", "chart-bar": "chart.bar",
        "file-text": "doc.text", "folder": "folder", "rocket": "paperplane", "book": "book", "bug": "ladybug", "flag": "flag",
        "clock": "clock", "search": "magnifyingglass", "settings": "gearshape", "star": "star", "package": "shippingbox",
    ]
    var body: some View {
        Image(systemName: name.flatMap { Self.symbols[$0] } ?? "square.grid.2x2")
            .font(.system(size: size * 0.45)).foregroundStyle(PhoneTheme.ink2)
            .frame(width: size, height: size).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: size * 0.26))
            .accessibilityHidden(true)
    }
}
