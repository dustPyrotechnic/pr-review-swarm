package report

type Row struct {
	Key   string
	Value int
}

type Report struct{ Total int }

func BuildReport(rows []Row) Report {
	r := Report{}

	n := len(rows)
	if n == 0 {
		return r
	}
	r.Total = n

	return r
}

