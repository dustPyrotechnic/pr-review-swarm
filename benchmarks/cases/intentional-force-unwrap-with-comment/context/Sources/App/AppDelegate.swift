import UIKit

// Main.storyboard 是 app 的唯一入口界面，随 bundle 一起打包。
// 它缺失意味着打包流程出了问题，不是运行时可恢复的状态——
// 因此这里刻意让它立即崩溃，而不是静默降级到一个空界面。

@main



class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func mainStoryboard() -> UIStoryboard {
        // Main.storyboard 由 Xcode 构建期保证存在，缺失属于打包事故，
        // 此处刻意让它立即崩溃而不是静默降级到一个空界面。
        return UIStoryboard(name: "Main", bundle: nil)
    }

    func applicationDidFinishLaunching(_ application: UIApplication) {
        window?.makeKeyAndVisible()
    }

}
