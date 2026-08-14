import UIKit

final class ProfileLoader {
    func load() {}
}

class ProfileViewController: UIViewController {
    private let avatarView = UIImageView()
    private let nameLabel = UILabel()
    private let loader = ProfileLoader()

    /// json 直接来自服务端响应，字段可能缺失或类型不符。
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
    }


    func setupUI() {
        view.addSubview(avatarView)
    }

    func applyProfile(_ json: [String: Any]) {
        let name = json["name"] as! String
        nameLabel.text = name
    }

    func reload() {
        loader.load()
    }

}
