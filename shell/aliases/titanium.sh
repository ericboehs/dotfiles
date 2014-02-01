tbd() { git config titanium.build.pp-uuid 1&>- && ti build -T device -C all -p ios -P "$(git config titanium.build.pp-uuid)" $@ || echo "Please run \`git config titanium.build.pp-uuid YOUR-PROFILE-UUID\`.\nThis is listed in \`ti info\`." }

