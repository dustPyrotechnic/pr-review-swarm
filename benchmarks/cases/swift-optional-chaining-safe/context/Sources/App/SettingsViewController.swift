import UIKit

struct Profile {
    let account: String
    let nickname: String?
}

// 设置页展示当前登录用户的昵称；未登录时 profile 为 nil。








class SettingsViewController: UITableViewController {
    private var profile: Profile?

    func displayName() -> String {
        guard let profile else { return "未登录" }
        return profile.nickname ?? profile.account
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
    }

}
