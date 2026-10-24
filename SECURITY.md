# Security

Please report security problems privately, not in a public issue: open the repository's
**Security** tab and choose **Report a vulnerability**.

OpenRig Studio is meant to run on your own computer. It listens on `127.0.0.1` only, and the
server refuses requests from other websites. Setting `HOST` to another address makes it
reachable from your network without a password; settings can then still only be changed on
the computer itself.
