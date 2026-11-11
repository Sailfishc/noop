package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Checkpoints (design step 5 「检查点」): where a task got to, kept off the computer that runs it, so that another
// could go on with it. The daemon saves them (src/checkpoint.ts): a repository task's whole worktree as a commit on
// agent/T-xxxx-wip in the repository itself (the server keeps only which commit), a general task's directory packed
// and stored here. The task keeps only its latest checkpoint (tasks_v1.checkpoint); the packed directory lives in its
// own table, which no path for people reads (not media: v1Media serves any id it is asked for), and goes 7 days after
// the task ended. A person sees only "检查点 14:02" on the task, or why there is none.

const checkpointSchema = `
CREATE TABLE IF NOT EXISTS checkpoint_blobs (id TEXT NOT NULL, n INTEGER NOT NULL, task_id TEXT NOT NULL, data BLOB,
  PRIMARY KEY (id, n));
CREATE INDEX IF NOT EXISTS checkpoint_blobs_task ON checkpoint_blobs (task_id);
`

const (
	maxCheckpointFiles = 100 << 20          // a general task's packed directory, at most (compressed)
	checkpointKeep     = 7 * 24 * time.Hour // how long after its task ended a packed directory is kept
)

// checkpointView: a task's latest checkpoint. At: when it was saved; Checked: when the machine last found it still
// current (nothing changed since). Repos: each repository's wip branch and commit (or why it was not saved); Files: the
// packed directory of a general task; Error: why that was not saved.
type checkpointView struct {
	At      int64            `json:"at"`
	Checked int64            `json:"checked"`
	Machine string           `json:"machine"`
	Repos   []checkpointRepo `json:"repos"`
	Files   *checkpointFiles `json:"files,omitempty"`
	Error   string           `json:"error,omitempty"`
}

type checkpointRepo struct {
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
	Commit string `json:"commit,omitempty"` // the checkpoint commit (its first parent: the task branch's HEAD then)
	Head   string `json:"head,omitempty"`
	Error  string `json:"error,omitempty"`
}

type checkpointFiles struct {
	ID   string `json:"id"`
	Size int64  `json:"size"`
}

var (
	shaRE      = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
	ckptFileRE = regexp.MustCompile(`^ckpt-[\w-]+$`)
)

// v1CheckpointFiles: the machine stores a general task's packed directory; the record that names it follows.
func (h *Hub) v1CheckpointFiles(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	if len(q.body) == 0 {
		errJSON(w, 400, "empty")
		return
	}
	if len(q.body) > maxCheckpointFiles {
		errJSON(w, 413, "检查点超过 100 MB")
		return
	}
	id := fmt.Sprintf("ckpt-%s-%d-%s", t.ID, h.nowMs(), uuid4()[:8])
	for n, i := 0, 0; ; n, i = n+1, i+chunk {
		e := min(i+chunk, len(q.body))
		h.must(h.db.Exec("INSERT INTO checkpoint_blobs (id, n, task_id, data) VALUES (?, ?, ?, ?)", id, n, t.ID, q.body[i:e]))
		if e == len(q.body) {
			break
		}
	}
	writeJSON(w, 200, obj{"id": id, "size": len(q.body)})
}

// v1Checkpoint: the machine records the task's checkpoint (or that the last one is still current: unchanged). Only
// the latest is kept; packed directories it no longer names go.
func (h *Hub) v1Checkpoint(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	var b struct {
		Unchanged bool             `json:"unchanged"`
		Repos     []checkpointRepo `json:"repos"`
		Files     *checkpointFiles `json:"files"`
		Error     string           `json:"error"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	now := h.nowMs()
	if b.Unchanged {
		if t.Checkpoint == nil {
			errJSON(w, 409, "还没有检查点")
			return
		}
		c := *t.Checkpoint
		c.Checked = now
		h.setCheckpoint(t.ID, c)
		writeJSON(w, 200, obj{"ok": true})
		return
	}
	c := checkpointView{At: now, Checked: now, Machine: q.who.machineID, Repos: []checkpointRepo{}, Error: trimmed(b.Error, 300)}
	for _, r := range b.Repos {
		if len(c.Repos) >= 10 {
			break
		}
		r.Repo, r.Branch, r.Error = trimmed(r.Repo, 200), trimmed(r.Branch, 200), trimmed(r.Error, 300)
		if !strings.HasPrefix(r.Branch, "agent/") || (r.Commit != "" && !shaRE.MatchString(r.Commit)) || (r.Head != "" && !shaRE.MatchString(r.Head)) {
			errJSON(w, 400, "检查点只能在 agent/ 分支上，提交号要完整")
			return
		}
		c.Repos = append(c.Repos, r)
	}
	if b.Files != nil {
		if !ckptFileRE.MatchString(b.Files.ID) || !strings.HasPrefix(b.Files.ID, "ckpt-"+t.ID+"-") ||
			h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE id = ? AND task_id = ?", b.Files.ID, t.ID) == 0 {
			errJSON(w, 400, "没有这个检查点文件")
			return
		}
		c.Files = &checkpointFiles{ID: b.Files.ID, Size: b.Files.Size}
	}
	keep := ""
	if c.Files != nil {
		keep = c.Files.ID
	}
	h.must(h.db.Exec("DELETE FROM checkpoint_blobs WHERE task_id = ? AND id != ?", t.ID, keep))
	h.setCheckpoint(t.ID, c)
	h.taskChanged(t.ID)
	writeJSON(w, 200, obj{"ok": true})
}

// setCheckpoint: the task's latest checkpoint, without touching its updated time (lists sort by it, and the week
// after it ended counts from it: a checkpoint is not a change people see as one).
func (h *Hub) setCheckpoint(id string, c checkpointView) {
	h.must(h.db.Exec("UPDATE tasks_v1 SET checkpoint = ? WHERE id = ?", jsonOrNil(c), id))
}

// checkpointFilesAllowed: whether the machine keeps general tasks' directories here (its owner's switch: on for a
// person's own computer, off for a team machine, unless set).
func (h *Hub) checkpointFilesAllowed(machineID string) bool {
	var on bool
	_ = h.db.QueryRow("SELECT COALESCE(checkpoint_files, CASE WHEN team = 1 THEN 0 ELSE 1 END) FROM machines WHERE id = ?", machineID).Scan(&on)
	return on
}

// tickCheckpoints: packed directories of tasks that ended a week ago go.
func (h *Hub) tickCheckpoints() {
	h.must(h.db.Exec(`DELETE FROM checkpoint_blobs WHERE task_id IN (SELECT id FROM tasks_v1 WHERE state IN ('done', 'closed') AND updated < ?)`,
		h.nowMs()-checkpointKeep.Milliseconds()))
}

func parseCheckpoint(s string) *checkpointView {
	if s == "" {
		return nil
	}
	c := &checkpointView{}
	if json.Unmarshal([]byte(s), c) != nil {
		return nil
	}
	if c.Repos == nil {
		c.Repos = []checkpointRepo{}
	}
	return c
}
