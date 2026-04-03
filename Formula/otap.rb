class Otap < Formula
  desc "Local observability TUI — tap into Datadog traces and Sentry errors"
  homepage "https://github.com/schester/otap"
  url "https://github.com/schester/otap/archive/refs/tags/v0.1.0.tar.gz"
  # sha256 "UPDATE_AFTER_FIRST_RELEASE"
  license "MIT"

  depends_on "oven-sh/bun/bun"

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
