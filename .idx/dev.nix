{ pkgs, ... }: {
  # Which nixpkgs channel to use.
  channel = "stable-24.05"; # or "unstable"
  
  packages = [
    pkgs.python3
    pkgs.glib       # Includes libgobject
    pkgs.nss        # Includes libnss3
    pkgs.nspr       # Includes libnspr4
    pkgs.atk        # Includes libatk1.0-0
    pkgs.cups       # Includes libcups2
    pkgs.libdrm
    pkgs.expat
    pkgs.xorg.libxcb
    pkgs.dbus
    pkgs.pango
    pkgs.cairo
    pkgs.libxkbcommon
    pkgs.systemd
    pkgs.xorg.libX11
    pkgs.xorg.libXext
    pkgs.mesa
    pkgs.python311Packages.pip
    pkgs.xorg.libXcomposite # Includes libxcomposite1
    pkgs.xorg.libXdamage    # Includes libxdamage1
    pkgs.xorg.libXfixes     # Includes libxfixes3
    pkgs.xorg.libXrandr     # Includes libxrandr2
    pkgs.alsaLib
    pkgs.ngrok               # Include ngrok package
    pkgs.docker              # Add Docker package
    pkgs.docker-compose
    pkgs.podman
  ];
  env = {};
  services.docker.enable = true;
  idx = {
    # Search for the extensions you want on https://open-vsx.org/ and use "publisher.id"
    extensions = [ "ms-python.python" ];
    workspace = {
      # Runs when a workspace is first created with this `dev.nix` file
      onCreate = {
        install =
          "python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt";
        # Open editors for the following files by default, if they exist:
        default.openFiles = [ "README.md" "src/index.html" "main.py" ];
      }; # To run something each time the workspace is (re)started, use the `onStart` hook
    };
    # Enable previews and customize configuration
    previews = {
      enable = true;
      previews = {
        web = {
          command = [ "./devserver.sh" ];
          env = { PORT = "$PORT"; };
          manager = "web";
        };
      };
    };
  };
}
