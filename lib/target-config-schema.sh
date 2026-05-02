# shellcheck shell=bash
#
# target-config-schema.sh — load + validate a target repo's .ralph/config.yaml.
#
# Library file. Source it, then call `tcs::validate <path>`. Returns 0 on
# success and a non-zero exit code with a human-readable message on stderr
# on any failure.
#
# Exit codes:
#   0  valid
#   2  usage / file not found
#   3  malformed yaml
#   4  missing required field
#   5  unknown field
#   6  type error or invalid value
#   7  missing dependency (yq)
#
# Dependency: yq v4 (mikefarah/yq) on PATH.
#
# Schema: see docs/config-schema.md.

tcs::__err() {
    printf 'target-config-schema: error: %s\n' "$*" >&2
}

tcs::__yq() {
    yq "$@" 2>/dev/null
}

tcs::__check_string_nonempty() {
    local path="$1" jp="$2"
    local t v
    t=$(tcs::__yq eval ".${jp} | type" "$path")
    if [[ "$t" != "!!str" ]]; then
        tcs::__err "${jp} must be a string, got ${t:-unknown}"
        return 6
    fi
    v=$(tcs::__yq eval ".${jp}" "$path")
    if [[ -z "$v" || "$v" == "null" ]]; then
        tcs::__err "${jp} must be a non-empty string"
        return 6
    fi
    return 0
}

tcs::validate() {
    local path="${1:-}"

    if [[ -z "$path" ]]; then
        tcs::__err "usage: tcs::validate <path-to-config.yaml>"
        return 2
    fi
    if [[ ! -f "$path" ]]; then
        tcs::__err "config file not found: $path"
        return 2
    fi

    if ! command -v yq >/dev/null 2>&1; then
        tcs::__err "yq (mikefarah/yq v4) is required on PATH"
        return 7
    fi

    local parse_err
    if ! parse_err=$(yq eval '.' "$path" 2>&1 >/dev/null); then
        tcs::__err "malformed yaml in ${path}: ${parse_err:-yq parse failed}"
        return 3
    fi

    local top_type
    top_type=$(tcs::__yq eval 'type' "$path")
    if [[ "$top_type" != "!!map" ]]; then
        tcs::__err "top-level must be a mapping, got ${top_type:-empty}"
        return 6
    fi

    local k has
    for k in build_cmd test_cmd branch_prefix review_bot; do
        has=$(tcs::__yq eval "has(\"$k\")" "$path")
        if [[ "$has" != "true" ]]; then
            tcs::__err "missing required field: $k"
            return 4
        fi
    done

    local allowed_top='^(build_cmd|test_cmd|branch_prefix|review_bot|agent_stuck_label|prompt_extensions)$'
    local key
    while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        if ! [[ "$key" =~ $allowed_top ]]; then
            tcs::__err "unknown field: ${key} (allowed: build_cmd, test_cmd, branch_prefix, review_bot, agent_stuck_label, prompt_extensions)"
            return 5
        fi
    done < <(tcs::__yq eval 'keys | .[]' "$path")

    tcs::__check_string_nonempty "$path" build_cmd     || return $?
    tcs::__check_string_nonempty "$path" test_cmd      || return $?
    tcs::__check_string_nonempty "$path" branch_prefix || return $?

    local bp
    bp=$(tcs::__yq eval '.branch_prefix' "$path")
    if [[ "$bp" == */* || "$bp" =~ [[:space:]] ]]; then
        tcs::__err "branch_prefix must not contain '/' or whitespace; got '${bp}'"
        return 6
    fi

    local rb_type
    rb_type=$(tcs::__yq eval '.review_bot | type' "$path")
    if [[ "$rb_type" != "!!map" ]]; then
        tcs::__err "review_bot must be a mapping, got ${rb_type:-empty}"
        return 6
    fi
    for k in username source; do
        has=$(tcs::__yq eval ".review_bot | has(\"$k\")" "$path")
        if [[ "$has" != "true" ]]; then
            tcs::__err "missing required field: review_bot.${k}"
            return 4
        fi
    done
    local allowed_rb='^(username|source)$'
    while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        if ! [[ "$key" =~ $allowed_rb ]]; then
            tcs::__err "unknown field: review_bot.${key} (allowed: username, source)"
            return 5
        fi
    done < <(tcs::__yq eval '.review_bot | keys | .[]' "$path")
    tcs::__check_string_nonempty "$path" 'review_bot.username' || return $?
    tcs::__check_string_nonempty "$path" 'review_bot.source'   || return $?
    local rb_source
    rb_source=$(tcs::__yq eval '.review_bot.source' "$path")
    case "$rb_source" in
        comment|review) ;;
        *)
            tcs::__err "review_bot.source must be 'comment' or 'review', got '${rb_source}'"
            return 6
            ;;
    esac

    if [[ "$(tcs::__yq eval 'has("agent_stuck_label")' "$path")" == "true" ]]; then
        tcs::__check_string_nonempty "$path" agent_stuck_label || return $?
    fi

    if [[ "$(tcs::__yq eval 'has("prompt_extensions")' "$path")" == "true" ]]; then
        local pe_type
        pe_type=$(tcs::__yq eval '.prompt_extensions | type' "$path")
        if [[ "$pe_type" != "!!map" ]]; then
            tcs::__err "prompt_extensions must be a mapping, got ${pe_type:-empty}"
            return 6
        fi
        local allowed_pe='^(discovery|implementation|review)$'
        while IFS= read -r key; do
            [[ -z "$key" ]] && continue
            if ! [[ "$key" =~ $allowed_pe ]]; then
                tcs::__err "unknown field: prompt_extensions.${key} (allowed: discovery, implementation, review)"
                return 5
            fi
            tcs::__check_string_nonempty "$path" "prompt_extensions.${key}" || return $?
        done < <(tcs::__yq eval '.prompt_extensions | keys | .[]' "$path")
    fi

    return 0
}
