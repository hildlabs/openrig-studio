# Security

Please report security problems privately, not in a public issue: open the repository's
**Security** tab and choose **Report a vulnerability**.

OpenRig Studio is meant to run on your own computer. It listens on `127.0.0.1` only, and the
server refuses requests from other websites. Setting `HOST` to another address (e.g.
`HOST=0.0.0.0`) makes it reachable from your network. Other devices then need the access link
that the terminal shows once (it contains a random token, or `OPENRIG_TOKEN` if you set one);
settings can still only be changed on the computer itself.
