// teamagent-server: the self-hosted coordination plane for noop machines and clients.
//
//	TEAMAGENT_TOKEN=<machine token> teamagent-server -addr :8080 -data /var/lib/teamagent
//
// Point every machine at it with [cloud] url = "http://<host>:8080" and [server] token = <the same token> in noop.toml.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Sailfishc/noop/server/internal/hub"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	addr := flag.String("addr", env("TEAMAGENT_ADDR", ":8080"), "listen address")
	data := flag.String("data", env("TEAMAGENT_DATA", "./data"), "directory for the SQLite database")
	static := flag.String("static", env("TEAMAGENT_STATIC", ""), "web client directory (app/dist/web/noop); empty: API only")
	owners := flag.String("owners", env("TEAMAGENT_OWNER_EMAIL", ""), "owner emails allowed to sign in, comma-separated")
	flag.Parse()

	token := os.Getenv("TEAMAGENT_TOKEN")
	if len(token) < 16 {
		log.Fatal("TEAMAGENT_TOKEN must be set to the machines' token (at least 16 characters)")
	}
	var smtp *hub.SMTPConfig
	if s := os.Getenv("TEAMAGENT_SMTP"); s != "" {
		smtp = &hub.SMTPConfig{}
		if err := json.Unmarshal([]byte(s), smtp); err != nil {
			log.Fatalf("TEAMAGENT_SMTP is not JSON {host, port, secure, user, pass, from}: %v", err)
		}
	}
	if err := os.MkdirAll(*data, 0o700); err != nil {
		log.Fatal(err)
	}
	db, err := hub.OpenDB(filepath.Join(*data, "hub.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	var emails []string
	for _, e := range strings.Split(*owners, ",") {
		if e = strings.TrimSpace(e); e != "" {
			emails = append(emails, e)
		}
	}
	h := hub.New(hub.Config{Token: token, OwnerEmails: emails, SMTP: smtp, StaticDir: *static}, db)

	srv := &http.Server{Addr: *addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("teamagent-server listening on %s (data %s)", *addr, *data)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
