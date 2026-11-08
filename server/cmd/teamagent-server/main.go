// teamagent-server: the self-hosted coordination plane for noop machines and clients.
//
//	TEAMAGENT_TOKEN=<machine token> teamagent-server -addr :8080 -data /var/lib/teamagent
//
//	teamagent-server invite -data /var/lib/teamagent -email you@company.com -role admin
//
// The invite prints a link: the first admin opens it, binds an authenticator app, and invites everyone else from
// the app. Each person adds their machines there and puts each machine's token in its noop.toml
// ([cloud] url = "http://<host>:8080", [server] token = "tam_…"). TEAMAGENT_TOKEN, a token shared by every machine,
// is the legacy noop setup and optional.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
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

func invite(args []string) {
	fs := flag.NewFlagSet("invite", flag.ExitOnError)
	data := fs.String("data", env("TEAMAGENT_DATA", "./data"), "directory for the SQLite database")
	email := fs.String("email", "", "the person's email")
	role := fs.String("role", "admin", "admin or member")
	base := fs.String("url", env("TEAMAGENT_URL", ""), "the server's address, to print a full link")
	_ = fs.Parse(args)
	if err := os.MkdirAll(*data, 0o700); err != nil {
		log.Fatal(err)
	}
	db, err := hub.OpenDB(filepath.Join(*data, "hub.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	code, err := hub.New(hub.Config{}, db).CreateInvite(*email, *role, "")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("邀请 %s（%s），7 天内有效：\n  %s/invite/%s\n", *email, *role, strings.TrimRight(*base, "/"), code)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "invite" {
		invite(os.Args[2:])
		return
	}
	addr := flag.String("addr", env("TEAMAGENT_ADDR", ":8080"), "listen address")
	data := flag.String("data", env("TEAMAGENT_DATA", "./data"), "directory for the SQLite database")
	static := flag.String("static", env("TEAMAGENT_STATIC", ""), "web client directory (app/dist/web/noop); empty: API only")
	owners := flag.String("owners", env("TEAMAGENT_OWNER_EMAIL", ""), "owner emails allowed to sign in, comma-separated")
	flag.Parse()

	token := os.Getenv("TEAMAGENT_TOKEN")
	if token != "" && len(token) < 16 {
		log.Fatal("TEAMAGENT_TOKEN, when set, must be at least 16 characters")
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
