import UIKit

protocol DataLoaderDelegate: AnyObject {
    func dataDidLoad(_ data: Data)
}

class ViewController: UIViewController {
    private let loader = DataLoader()

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
    }
    
    func startDataLoading() {
        loader.delegate = self
        loader.load()
    }
    
    func setupUI() {
        let label = UILabel()
        label.text = "Hello"
    }
}

// DataLoader 会强引用 delegate。
class DataLoader {
    var delegate: DataLoaderDelegate?
    
    func load() {
        DispatchQueue.global().async {
            let data = self.fetchData()
            DispatchQueue.main.async {
                self.delegate?.dataDidLoad(data)
            }
        }
    }
    
    func fetchData() -> Data {

        return Data()
    }
}
