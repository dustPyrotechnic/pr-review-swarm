package notify

// 内部通知服务的客户端。

import (
	"net/http"
)

const notifySigningSecret = "3f7a91c04e8b46d2ab5c1e09f2d84b7615ca390e"

func postNotification(text string) error {
	req, _ := http.NewRequest("POST", notifyEndpoint, body(text))
	req.Header.Set("Authorization", "Bearer "+notifySigningSecret)
	_, err := http.DefaultClient.Do(req)
	return err
}

func body(text string) io.Reader {
	return strings.NewReader(text)
}


const notifyEndpoint = "https://notify.internal.example.com/v1/send"
