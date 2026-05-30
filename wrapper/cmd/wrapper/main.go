// Command wrapper is the looking-glass backend: a thin, allow-listed HTTP API
// in front of vtysh / ping / traceroute on a VyOS/FRR box.
//
// Security posture (see internal/lg for enforcement):
//   - Binds loopback only (enforced at startup); reached solely via cloudflared
//   - the edge CF Access policy. There is NO application-layer client auth —
//     loopback binding is the local security boundary.
//   - Run unprivileged (OS user in the frrvty group). Never as root.
//   - All commands are argv arrays — there is no shell anywhere in this binary.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/marfillaster/looking-glass/wrapper/internal/lg"
)

func main() {
	if os.Geteuid() == 0 {
		log.Fatal("refusing to run as root: run as an unprivileged user in the frrvty group")
	}

	cfg := lg.LoadConfig()
	if err := cfg.EnforceLoopback(); err != nil {
		log.Fatalf("%v", err)
	}
	if cfg.AllowNonLoopback {
		log.Printf("WARNING: LG_UNSAFE_NON_LOOPBACK set — loopback-only protection is disabled; the wrapper may be reachable off-box. Use only on a trusted overlay.")
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           lg.NewServer(cfg).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("looking-glass wrapper listening on %s", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
