# Terms of use

These terms are the ones PRD §15 asks for, and they are deliberately short:
Dropbeam sends files directly from one device to another, and the interesting
questions are about what you send, who is responsible for it, and what the
tool is not.

## The tool is provided as-is

Dropbeam is provided as it is, without warranty of any kind. It is a
browser-based file transfer tool: two devices pair over a direct WebRTC
connection, and the bytes travel encrypted between them, never through a
server the project runs. There is no account, no dashboard, no support
contract, and no service level. Use it at your own risk, on networks and
devices you are allowed to use.

## You are responsible for what you send

You are responsible for the files you send and the files you accept. The
other device in a transfer is a stranger's device until the verification
phrase matches, so check the words on both screens before allowing anything -
that check is the whole point of the design, and it only works if you read
it. Do not use Dropbeam to send anything you would not be comfortable
handing to the person on the other end, and make sure you are allowed to
send it at all.

## Prohibited use

Do not use Dropbeam to send or receive illegal content, to infringe anyone
else's rights, to attack or disrupt a network or a device, or to circumvent
the access controls of a system or a network. In particular, sending malware,
or content that is unlawful where it is sent, is prohibited.

## What is collected

Nothing: no accounts, no analytics, no cookies, and no third-party requests
unless you turn on the optional STUN mode, which discloses your public
address to a STUN server and nothing else. The full account is in
[PRIVACY.md](PRIVACY.md), and the hosting provider's own logs are outside
this project's control.

## The name

Dropbeam is not affiliated with, endorsed by, or connected to Apple, and it
is not AirDrop. The comparison is descriptive and only appears in this
project's own documentation.
