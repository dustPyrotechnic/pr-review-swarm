import UIKit

/// 全局共享的图片缓存。
/// 注意：storage 没有任何同步保护，而多个后台队列会并发调用 store(_:for:)。

@MainActor
final class ImageCache {
    private var storage: [String: UIImage] = [:]

    // 供后台队列直接调用
    nonisolated func store(_ image: UIImage, for key: String) {
        storage[key] = image
    }

    func image(for key: String) -> UIImage? {
        return storage[key]
    }

}
