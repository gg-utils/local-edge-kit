#!/bin/sh
# Guard for the repo rule in README.md: nothing tracked here may name the earlier platform
# or its UI product.
#
# The two forbidden words are never written out in this file, because the file is tracked
# too. Each alternative of the pattern below is split by a character class or an optional
# separator, so the pattern text does not match itself.
#
# Usage:
#   check-forbidden-names.sh tree                 tracked file contents and paths (HEAD)
#   check-forbidden-names.sh staged               index contents and paths (pre-commit)
#   check-forbidden-names.sh range <base> <head>  every commit in base..head: its whole
#                                                 tree, its paths, its message and author
#   check-forbidden-names.sh ref <refname>        one ref: its name and, for a tag, its text
#   check-forbidden-names.sh refs                 every ref in this clone (local audit)
#   check-forbidden-names.sh text                 text on stdin (commit message, PR text)
#
# Contents are searched as bytes in the C locale, so binary files and invalid UTF-8 are
# searched too. Symbolic links are tracked as blobs that hold the link target; those
# targets are searched as well, without following the link. Only file names are printed
# for content matches, so binary data never reaches the terminal.
#
# Exit status: 0 clean, 1 forbidden name found, 2 usage error or a failed git command.
# A git failure is never reported as clean.
set -eu

# Byte-wise matching: a UTF-8 locale can make grep skip lines with invalid sequences.
LC_ALL=C
export LC_ALL

PATTERN='ai[-_]?profile|clo[o]m'

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/forbidden-names.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM
found=0

fail_usage() {
  echo "usage: $0 tree | staged | range <base> <head> | ref <refname> | refs | text" >&2
  exit 2
}

die() {
  echo "forbidden-names: error: $1" >&2
  exit 2
}

# git_out <file> <git args...>: runs git, writes stdout to <file>, stops on any git error.
git_out() {
  out="$1"
  shift
  git "$@" > "$out" || die "git $1 failed"
}

# scan_file <label> <file>: reports lines of <file> that match. Sets found=1 on a match.
scan_file() {
  status=0
  grep -a -n -i -E "$PATTERN" "$2" > "$tmpdir/hits" || status=$?
  case "$status" in
    0)
      sed "s|^|  $1: |" "$tmpdir/hits" >&2
      found=1
      ;;
    1) ;;
    *) die "grep failed while scanning $1" ;;
  esac
}

# grep_blobs <label> <where>: searches blob contents and prints matching file names.
# <where> is "--cached" for the index, or a commit.
grep_blobs() {
  status=0
  if [ "$2" = "--cached" ]; then
    git grep --cached -a -l -i -E -e "$PATTERN" > "$tmpdir/blobs" || status=$?
  else
    git grep -a -l -i -E -e "$PATTERN" "$2" > "$tmpdir/blobs" || status=$?
  fi
  case "$status" in
    0)
      sed "s|^|  $1: |" "$tmpdir/blobs" >&2
      found=1
      ;;
    1) ;;
    *) die "git grep failed while scanning $1" ;;
  esac
}

# scan_symlinks <label> <field> <listing>: <listing> is `git ls-files -s` (<field> 2) or
# `git ls-tree -r` (<field> 3) output. git grep skips symbolic links, so their stored
# targets are read from the object store and scanned here.
scan_symlinks() {
  awk -v field="$2" '$1 == "120000" { print $field }' "$3" > "$tmpdir/links"
  : > "$tmpdir/targets"
  while read -r blob; do
    git cat-file -p "$blob" >> "$tmpdir/targets" || die "git cat-file failed"
    echo >> "$tmpdir/targets"
  done < "$tmpdir/links"
  scan_file "$1" "$tmpdir/targets"
}

mode="${1:-}"
case "$mode" in
  tree)
    git_out "$tmpdir/paths" ls-files
    scan_file "path" "$tmpdir/paths"
    grep_blobs "content" HEAD
    git_out "$tmpdir/listing" ls-tree -r HEAD
    scan_symlinks "symlink target" 3 "$tmpdir/listing"
    ;;
  staged)
    git_out "$tmpdir/paths" ls-files
    scan_file "path" "$tmpdir/paths"
    grep_blobs "content" --cached
    git_out "$tmpdir/listing" ls-files -s
    scan_symlinks "symlink target" 2 "$tmpdir/listing"
    ;;
  range)
    base="${2:-}"
    head="${3:-}"
    if [ -z "$base" ] || [ -z "$head" ]; then fail_usage; fi
    git rev-parse --verify --quiet "$base^{commit}" > /dev/null || die "unknown base commit: $base"
    git rev-parse --verify --quiet "$head^{commit}" > /dev/null || die "unknown head commit: $head"
    git_out "$tmpdir/commits" rev-list "$base..$head"
    while read -r commit; do
      short=$(git rev-parse --short "$commit") || die "git rev-parse failed"
      git_out "$tmpdir/paths" ls-tree -r --name-only "$commit"
      scan_file "path in $short" "$tmpdir/paths"
      grep_blobs "content" "$commit"
      git_out "$tmpdir/listing" ls-tree -r "$commit"
      scan_symlinks "symlink target in $short" 3 "$tmpdir/listing"
      git_out "$tmpdir/message" log -1 --format='%an <%ae>%n%cn <%ce>%n%B' "$commit"
      scan_file "message or author of $short" "$tmpdir/message"
    done < "$tmpdir/commits"
    ;;
  ref)
    refname="${2:-}"
    if [ -z "$refname" ]; then fail_usage; fi
    printf '%s\n' "$refname" > "$tmpdir/refs"
    scan_file "ref name" "$tmpdir/refs"
    case "$refname" in
      refs/tags/*)
        git_out "$tmpdir/tags" for-each-ref --format='%(contents)' "$refname"
        scan_file "tag text" "$tmpdir/tags"
        ;;
    esac
    ;;
  refs)
    git_out "$tmpdir/refs" for-each-ref --format='%(refname)'
    scan_file "ref name" "$tmpdir/refs"
    git_out "$tmpdir/tags" for-each-ref --format='%(refname) %(contents)' refs/tags
    scan_file "tag text" "$tmpdir/tags"
    ;;
  text)
    cat > "$tmpdir/text"
    scan_file "text" "$tmpdir/text"
    ;;
  *)
    fail_usage
    ;;
esac

if [ "$found" -ne 0 ]; then
  echo "forbidden-names: a name of the earlier platform or its UI was found ($mode)." >&2
  echo "forbidden-names: move the detail to the private place and use neutral wording." >&2
  exit 1
fi

echo "forbidden-names: clean ($mode)"
