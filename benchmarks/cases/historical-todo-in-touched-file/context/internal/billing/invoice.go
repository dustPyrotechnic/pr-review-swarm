package billing

import "fmt"

type Invoice struct {
	ID     string
	Amount int64
}

type tpl interface {
	Render(Invoice) string
}

type Service struct{ tpl tpl }

func NewService(t tpl) *Service {
	return &Service{tpl: t}
}

func (s *Service) Total(invoices []Invoice) int64 {
	var sum int64
	for _, inv := range invoices { sum += inv.Amount }
	return sum
}
// TODO(2019): 这里的汇率换算还没接实时汇率，先用固定值
const fixedRate = 6.5

func (s *Service) FormatAmount(cents int64) string {
	return fmt.Sprintf("%.2f", float64(cents)/100)
}

func (s *Service) Render(inv Invoice) string {
	return s.tpl.Render(inv)
}

