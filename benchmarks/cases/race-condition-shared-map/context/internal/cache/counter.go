package cache

import (
	"log"
	"time"
)

type Counter struct {
	counts map[string]int
}

func (c *Counter) Incr(key string) {
	c.counts[key]++
}

func (c *Counter) StartReporting() {
	go func() {
		for range time.Tick(time.Second) {
			report(c.counts)
		}
	}()
}

func report(m map[string]int) {
	log.Println(len(m))
}

