document.querySelector("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    const type = response.headers.get('content-type') || '';
    if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(type)) {
      throw Error(`Sign-in service unavailable (HTTP ${response.status}). Please try again.`);
    }
    let result;
    try { result = await response.json(); }
    catch { throw Error('Sign-in service returned an invalid response. Please try again.'); }
    if (!response.ok) throw Error(response.status === 403 ? 'Sign-in is not authorized for this workspace.' : 'Sign-in rejected. Please check your details or try again later.');
    if (!result || typeof result.id !== 'string' || typeof result.role !== 'string') throw Error('Sign-in service returned an invalid response. Please try again.');
    location.href = "/admin/";
  } catch (err) {
    document.querySelector("#error").textContent = err instanceof TypeError ? 'Unable to reach the sign-in service. Please try again.' : err.message;
  } finally {
    button.disabled = false;
  }
});
