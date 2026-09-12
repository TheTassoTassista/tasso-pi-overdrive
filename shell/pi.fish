# Managed by tasso-pi-overdrive. Reinstall with scripts/install-pi-launcher.sh.
function pi
    set -l launcher "$HOME/.local/bin/pi-overdrive-launcher"
    if not test -x "$launcher"
        echo "Pi Overdrive launcher is missing: $launcher" >&2
        return 127
    end
    command "$launcher" $argv
end
