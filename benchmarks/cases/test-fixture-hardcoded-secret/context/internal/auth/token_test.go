package auth

import "testing"

// signForTest 只在测试里用，签名密钥由调用方传入。
func signForTest(t *testing.T, key, subject string) string {
	t.Helper()
	tok, err := Sign(subject, key)
	if err != nil {
		t.Fatalf("sign failed: %v", err)
	}
	return tok
}
func TestVerifyToken(t *testing.T) {
	t.Parallel()

	// 这是测试专用的假密钥，不对应任何真实环境
	const testSigningKey = "test-only-signing-key-do-not-use-in-prod"
	tok := signForTest(t, testSigningKey, "user-1")

	if _, err := Verify(tok, testSigningKey); err != nil {
		t.Fatalf("verify failed: %v", err)
	}
}

