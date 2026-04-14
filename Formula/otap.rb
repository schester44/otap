class Otap < Formula
  desc "Local observability TUI — tap into Datadog, OpenTelemetry, and Sentry"
  homepage "https://github.com/schester44/otap"
  url "https://github.com/schester44/otap/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "52608db669c61bad50da1c65596006c7eefe836da32f7406622cad02afb8472a"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  # OpenTUI ships a native dylib that Homebrew shouldn't relink
  skip_clean "libexec"

  def install
    libexec.install "src", "package.json", "tsconfig.json"

    system "bun", "install", "--cwd", libexec

    (bin/"otap").write <<~EOS
      #!/usr/bin/env bash
      exec bun run "#{libexec}/src/index.tsx" "$@"
    EOS
  end

  test do
    port = free_port
    fork do
      exec bin/"otap", env: { "DD_PORT" => port.to_s }
    end
    sleep 2
    output = shell_output("curl -s http://localhost:#{port}/api/summary")
    assert_match "traceCount", output
  end
end
