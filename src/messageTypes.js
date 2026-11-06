// Mirrors docs/signaling-protocol.md — keep both in sync.
module.exports = {
  REGISTER: 'register',
  REGISTERED: 'registered',
  CALL_INVITE: 'call-invite',
  CALL_RING: 'call-ring',
  SDP_OFFER: 'sdp-offer',
  SDP_ANSWER: 'sdp-answer',
  ICE_CANDIDATE: 'ice-candidate',
  CALL_ACCEPT: 'call-accept',
  CALL_REJECT: 'call-reject',
  CALL_CANCEL: 'call-cancel',
  CALL_END: 'call-end',
  BUSY: 'busy',
  TIMEOUT: 'timeout',
  ERROR: 'error',
};
