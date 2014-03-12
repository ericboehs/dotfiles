tb() { ti build -p ios }

tbd() {
  [[ -z $DEVICE_UDID ]] && DEVICE_UDID=$(git config titanium.build.device-udid)
  git config titanium.build.pp-uuid >& /dev/null \
    && ti build -T device -C "${DEVICE_UDID:-all}" -p ios -P "$(git config titanium.build.pp-uuid)" $@ \
    || echo "Please run \`git config titanium.build.pp-uuid YOUR-PROFILE-UUID\`.\nThis is listed in \`ti info\`."
}

tbtf() {
  git config titanium.build.dist-pp-uuid >& /dev/null \
    && ti build -T dist-adhoc -p ios --testflight -P "$(git config titanium.build.dist-pp-uuid)" -O dist -R "$(git config titanium.build.dist-cert)"
    || echo "Please run \`git config titanium.build.dist-pp-uuid YOUR-PROFILE-UUID\`.\nThis is listed in \`ti info\`."
}

