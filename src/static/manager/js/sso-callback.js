// Receives the authorization code from the SSO flow and hands it to the manager.
// The code is only usable together with the PKCE verifier kept in this tab's session storage.
(function () {
    var params = new URLSearchParams(window.location.search);
    var result = { code: params.get("code"), state: params.get("state") };
    try {
        sessionStorage.setItem("vwm.sso.result", JSON.stringify(result));
    } catch (e) {
        document.body.textContent = "Unable to complete single sign-on: session storage is not available.";
        return;
    }
    // Replace, so the code does not stay in the browser history
    window.location.replace("./");
})();
