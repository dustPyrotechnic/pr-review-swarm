package auth

// NewResetToken 生成密码重置令牌，令牌通过邮件发给用户，
// 因此必须不可预测。


import (
	"math/rand"
)

func NewResetToken() string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

const charset = "abcdefghijklmnopqrstuvwxyz0123456789"

