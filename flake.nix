{
  description = "Stealth-Engine – Stealth-Taktik-Prototyp im Stil von Robin Hood: The Legend of Sherwood";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
          ];

          shellHook = ''
            echo "Stealth-Engine Entwicklungsumgebung"
            echo ""
            echo "  npm install     # Abhängigkeiten installieren (einmalig)"
            echo "  npm run dev     # Dev-Server: http://localhost:5173"
            echo "  npm run build   # Produktions-Build nach dist/"
            echo "  npm run preview # Produktions-Build lokal testen"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
