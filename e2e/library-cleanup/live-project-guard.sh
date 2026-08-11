#!/bin/sh

: "${SCRIPT_DIR:?live-project-guard.sh requires SCRIPT_DIR}"
: "${PROJECT_NAME:?live-project-guard.sh requires PROJECT_NAME}"

if [ -z "${LC_E2E_RUN_TOKEN:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	LC_E2E_RUN_TOKEN=$(sed -n 's/^LC_E2E_RUN_TOKEN=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export LC_E2E_RUN_TOKEN
fi

case "${LC_E2E_RUN_TOKEN:-}" in
	????????????????????????????????????????????????????????????????)
		case "$LC_E2E_RUN_TOKEN" in
			*[!0-9a-f]*) echo "Harness refused: LC_E2E_RUN_TOKEN must be 64 lowercase hex characters." >&2; exit 1 ;;
		esac
		;;
	*) echo "Harness refused: set one random 64-character lowercase hex LC_E2E_RUN_TOKEN per run." >&2; exit 1 ;;
esac

acquire_live_project_lock() {
	if ! command -v flock >/dev/null 2>&1; then
		echo "Harness refused: flock is required for the per-project mutation lock." >&2
		exit 2
	fi
	lock_root=${LC_E2E_LOCK_ROOT:-${XDG_RUNTIME_DIR:-/tmp}/arr-dashboard-library-cleanup-locks}
	mkdir -p "$lock_root"
	lock_file=$lock_root/$PROJECT_NAME.lock
	exec 9>"$lock_file"
	if ! flock -n 9; then
		echo "Harness refused: another process owns the live lock for $PROJECT_NAME." >&2
		exit 1
	fi
}

verify_live_project() {
	allow_empty=${1:-}
	model_file=$(mktemp "${TMPDIR:-/tmp}/lc-e2e-live-model.XXXXXX")
	hash_file=$(mktemp "${TMPDIR:-/tmp}/lc-e2e-live-hashes.XXXXXX")
	if ! compose --profile candidate-sqlite --profile candidate-postgres --profile baseline \
		config --format json >"$model_file" || \
		! compose --profile candidate-sqlite --profile candidate-postgres --profile baseline \
		config --hash='*' >"$hash_file"; then
		rm -f "$model_file" "$hash_file"
		return 1
	fi
	if [ "$allow_empty" = "--allow-empty" ]; then
		python3 "$SCRIPT_DIR/check-live-project.py" --model "$model_file" --hashes "$hash_file" \
			--project "$PROJECT_NAME" --run-token "$LC_E2E_RUN_TOKEN" \
			--config-files "$SCRIPT_DIR/compose.yml,$SCRIPT_DIR/compose.debug.yml" \
			--working-dir "$SCRIPT_DIR" --allow-empty
	else
		python3 "$SCRIPT_DIR/check-live-project.py" --model "$model_file" --hashes "$hash_file" \
			--project "$PROJECT_NAME" --run-token "$LC_E2E_RUN_TOKEN" \
			--config-files "$SCRIPT_DIR/compose.yml,$SCRIPT_DIR/compose.debug.yml" \
			--working-dir "$SCRIPT_DIR"
	fi
	result=$?
	rm -f "$model_file" "$hash_file"
	return "$result"
}
