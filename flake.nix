{
  description = "web-dev-kit: shared checks and stack dev shells for web projects";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # Only for playwright-driver: its version must equal the npm `playwright`
    # in package.json (1.63.0), or Linux browsers will not launch. 26.05 ships
    # 1.59.1; unstable had 1.63.0 on 2026-10-05.
    nixpkgs-browsers.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, nixpkgs-browsers }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      src = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [ ./bin ./lib ./package.json ./bun.lock ];
      };
    in {
      packages = forAll (pkgs: rec {
        # Fixed-output: bun fetches over the network, Nix pins the result by hash.
        # Bump the hash whenever bun.lock changes (build once with lib.fakeHash).
        node-modules = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-dev-kit-node-modules";
          version = "0.2.6";
          inherit src;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --production --ignore-scripts
          '';
          # Nested, not $out itself: a realpath'd import (/nix/store/…/postcss/lib/input.js)
          # must still find its siblings by walking up to a node_modules dir.
          installPhase = "mkdir $out && cp -r node_modules $out/";
          dontFixup = true;
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-KC0q1o7IB6uufgsbubqWJLScFdHUEenf9Kf/oOCtAWo=";
        };
        wdk = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-dev-kit";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          inherit src;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/web-dev-kit $out/bin
            cp -r bin lib package.json $out/share/web-dev-kit/
            ln -s ${node-modules}/node_modules $out/share/web-dev-kit/node_modules
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/wdk --add-flags $out/share/web-dev-kit/bin/wdk.js
          '';
        };
        default = wdk;
      } // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
        firefox-esr-115 = pkgs.stdenvNoCC.mkDerivation rec {
          pname = "firefox-esr-115";
          version = "115.42.0esr";
          src = pkgs.fetchurl {
            name = "Firefox-${version}.dmg"; # the %20 in the url would otherwise leak into the store name
            url = "https://ftp.mozilla.org/pub/firefox/releases/${version}/mac/en-US/Firefox%20${version}.dmg";
            hash = "sha256-IBPjjiyqGBOEJBWaH4O8GdUYggxgVWFiG78hkNCyQWA=";
          };
          nativeBuildInputs = [ pkgs.undmg ];
          sourceRoot = ".";
          dontBuild = true;
          dontFixup = true; # re-signing or patching would break the notarised bundle
          installPhase = ''
            mkdir -p $out/Applications
            cp -R Firefox.app $out/Applications/
            # The store is read-only, so it cannot update; the policy also stops it trying.
            mkdir -p $out/Applications/Firefox.app/Contents/Resources/distribution
            echo '{"policies":{"AppAutoUpdate":false,"ManualAppUpdateOnly":true,"DisableAppUpdate":true}}' \
              > $out/Applications/Firefox.app/Contents/Resources/distribution/policies.json
          '';
        };
      });

      lib.devShell = { pkgs, stack ? "static", packages ? [ ] }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          stacks = {
            static = [ ];
            # Eleventy comes from the project's bun dependencies.
            eleventy = [ ];
            # Vite comes from the project's bun dependencies.
            vite = [ ];
            astro = [ ];
            # Same attribute as the vps PHP-FPM pool (services.phpfpm.pools.*.phpPackage).
            kirby = [ pkgs.php85 pkgs.php85Packages.composer ];
          };
        in pkgs.mkShell {
          packages = [ self.packages.${system}.wdk pkgs.just pkgs.bun ] ++ stacks.${stack} ++ packages;
          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_BROWSERS_PATH=${nixpkgs-browsers.legacyPackages.${system}.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            # Nix's WebKit (WPE) finds no EGL driver off NixOS (no /run/opengl-driver) and
            # aborts every newPage: "Could not create EGL display". Point it at Mesa's.
            export __EGL_VENDOR_LIBRARY_DIRS=${nixpkgs-browsers.legacyPackages.${system}.mesa}/share/glvnd/egl_vendor.d
          '' + pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
            export WDK_FIREFOX_115=${self.packages.${system}.firefox-esr-115}/Applications/Firefox.app/Contents/MacOS/firefox
          '';
        };

      # A build-stack site as a store path: `packages.default = wdk.lib.buildSite { ... }`.
      # Installs every platform's native bindings (--os/--cpu '*'), so the hash is the same on a Mac and the server.
      # `nodeModulesHash`: build once with lib.fakeHash, paste the `got:`; bump after every bun.lock change.
      lib.buildSite = { pkgs, src, nodeModulesHash, build ? "bun --bun x vite build", out ? "dist" }:
        let
          nodeModules = pkgs.stdenvNoCC.mkDerivation {
            name = "site-node-modules";
            src = pkgs.lib.fileset.toSource {
              root = src;
              fileset = pkgs.lib.fileset.unions [ (src + "/package.json") (src + "/bun.lock") ];
            };
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            buildPhase = ''
              export HOME=$TMPDIR
              bun install --frozen-lockfile --ignore-scripts --os='*' --cpu='*'
            '';
            installPhase = "mkdir $out && cp -r node_modules $out/";
            dontFixup = true;
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = nodeModulesHash;
          };
        in pkgs.stdenvNoCC.mkDerivation {
          name = "site";
          inherit src;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            set -x # a failure here is otherwise silent in the last-lines log
            export HOME=$TMPDIR
            cp -r ${nodeModules}/node_modules node_modules
            chmod -R u+w node_modules
            ${build}
          '';
          installPhase = "cp -r ${out} $out";
          dontFixup = true;
        };

      templates = nixpkgs.lib.genAttrs [ "static" "kirby" "eleventy" "vite" "astro" ] (name: {
        path = ./templates/${name};
        description = "web-dev-kit ${name} project";
      });

      devShells = forAll (pkgs: { default = self.lib.devShell { inherit pkgs; }; });
    };
}
