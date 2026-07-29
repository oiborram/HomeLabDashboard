const form = document.querySelector('#loginForm');
const input = document.querySelector('#accessCode');
const feedback = document.querySelector('#feedback');
const hint = document.querySelector('#hint');
const submitButton = form.querySelector('button');

initialize();

async function initialize() {
  try {
    const response = await fetch('/auth/status', { cache: 'no-store' });
    const status = await response.json();

    if (status.authenticated) {
      window.location.replace('/');
      return;
    }

    input.maxLength = status.codeDigits;
    input.placeholder = '0'.repeat(status.codeDigits);
    hint.textContent = `El código se renueva cada ${status.periodSeconds} segundos.`;

    if (!status.configured) {
      disableForm('El acceso todavía no está configurado en el servidor.');
    } else if (!status.telegramReady) {
      feedback.textContent = 'El bot está sincronizando el código con Telegram…';
    }
  } catch {
    disableForm('No se puede contactar con el servicio de acceso.');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  feedback.className = 'feedback';
  feedback.textContent = '';
  submitButton.disabled = true;

  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.value })
    });

    if (response.ok) {
      feedback.className = 'feedback success';
      feedback.textContent = 'Acceso correcto.';
      window.location.replace('/');
      return;
    }

    const result = await response.json();
    feedback.textContent = result.error ?? 'No se pudo validar el código.';
    input.select();
  } catch {
    feedback.textContent = 'No se puede contactar con el servicio de acceso.';
  } finally {
    submitButton.disabled = false;
  }
});

input.addEventListener('input', () => {
  input.value = input.value.replace(/\D/gu, '');
});

function disableForm(message) {
  input.disabled = true;
  submitButton.disabled = true;
  feedback.textContent = message;
}
