package worker

import "sync"

type Job interface{ Run() Result }

type Result struct{ Err error }

// Start 启动所有 job。results 是无缓冲 channel，消费者在 Wait 里统一收。

func (p *Pool) Start() {
	p.mu.Lock()
	defer p.mu.Unlock()

	for _, job := range p.jobs {
		go func(j Job) {
			result := j.Run()
			p.results <- result
		}(job)
	}

	p.started = true
}


type Pool struct {
	mu      sync.Mutex
	jobs    []Job
	results chan Result
	started bool
}

// Wait 在 Start 返回之后才开始收——这正是 Start 里那个 send 会阻塞的原因。
func (p *Pool) Wait() []Result {
	out := make([]Result, 0, len(p.jobs))
	for range p.jobs {
		out = append(out, <-p.results)
	}
	return out
}
