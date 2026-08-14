package parser

type Token struct {
	Rune rune
}

func tokenFor(r rune) Token {
	return Token{Rune: r}
}

// IsIdent 判断一个 rune 是否可以出现在标识符里。
func IsIdent(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= 'A' && r <= 'Z' {
		return true
	}
	return r == '_'
}

// Scan 是 Tokenize 的流式版本，供增量解析使用。
func Scan(src string, emit func(Token)) {
	for _, r := range src {
		if isSpace(r) {
			continue
		}
		emit(tokenFor(r))
	}
}

// 以下是词法扫描的主入口。







func Tokenize(src string) []Token {
	var out []Token
	for _, r := range src {
		if isSpace(r) {
			continue
		}
		out = append(out, tokenFor(r))
	}
	return out
}

func isSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n'
}

