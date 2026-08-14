package scheduler

import "time"

type spec interface {
	Next(time.Time) time.Time
}

type Scheduler struct{ spec spec }

func New(s spec) *Scheduler {
	return &Scheduler{spec: s}
}

// Run 按调度点反复触发 fn，直到 stop 被关闭。
func (s *Scheduler) Run(stop <-chan struct{}, fn func()) {
	now := time.Now()
	for {
		next := s.Next(now)
		select {
		case <-stop:
			return
		case <-time.After(time.Until(next)):
			fn()
			now = next
		}
	}
}

func (s *Scheduler) Next(t time.Time) time.Time {
	// Next 返回严格晚于 t 的下一次执行时间；t 恰好命中调度点时会跳到再下一次，
	// 以免同一时刻被触发两遍。
	return s.spec.Next(t)
}

