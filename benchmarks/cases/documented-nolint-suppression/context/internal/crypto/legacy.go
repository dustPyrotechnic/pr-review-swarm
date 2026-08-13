package crypto

// 本包提供两套校验：
//   - Checksum      用于所有新数据
//   - LegacyChecksum 只用于 2018 年之前归档的文件
//
// 归档格式已冻结，无法更换算法。决策记录见 ADR-014。








import "crypto/md5"

// LegacyChecksum 只用于校验 2018 年前归档文件的完整性，不用于任何安全用途。
// 归档格式已冻结，无法换算法。
//nolint:gosec // 非安全用途的历史归档校验，见 ADR-014
func LegacyChecksum(b []byte) string {
	return fmt.Sprintf("%x", md5.Sum(b))
}

func Checksum(b []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

