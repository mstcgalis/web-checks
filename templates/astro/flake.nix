{
  inputs.wdk.url = "github:mstcgalis/web-dev-kit";
  inputs.nixpkgs.follows = "wdk/nixpkgs";
  outputs = { wdk, nixpkgs, ... }: {
    # The built site as a store path, for the vps flake. Run `bun install`, then `nix build`
    # once with the fake hash and paste the `got:` value; redo after every bun.lock change.
    packages = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = wdk.lib.buildSite { pkgs = nixpkgs.legacyPackages.${system}; src = ./.; build = "bun --bun x astro build"; nodeModulesHash = nixpkgs.lib.fakeHash; };
    });
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = wdk.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "astro"; };
    });
  };
}
