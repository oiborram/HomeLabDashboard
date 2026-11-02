# Acceso mediante código compartido de Telegram

## Public crawler discovery

`GET`/`HEAD /robots.txt` is registered before session authentication and now
disallows crawling the entire private homelab. The portfolio moved to GitHub
Pages on 2 November 2026; the former public `/sitemap.xml` responds with HTTP
410 Gone and advertises no retired application URLs. These fixed responses
expose no private services and derive nothing from request headers. All
dashboard pages, APIs and server controls retain authentication. Publish this
source change through Lisa; no router, authentication or port change is needed.

El dashboard usa un código numérico compartido que cambia cada 30 segundos. El bot
publica el código en un único mensaje del grupo y lo actualiza automáticamente. Tras
validarlo, el navegador conserva una sesión mediante una cookie segura.

## Preparación de Telegram

1. Habla con `@BotFather`, crea un bot con `/newbot` y guarda el token.
2. Añade el bot al grupo privado.
3. Hazlo administrador con permisos para publicar y fijar mensajes.
4. Obtén el identificador numérico del grupo. En supergrupos suele comenzar por
   `-100`; puede obtenerse temporalmente consultando `getUpdates` después de escribir
   un mensaje en el grupo.

## Variables necesarias

```text
AUTH_ENABLED=true
AUTH_CODE_SECRET=<secreto aleatorio de 32 caracteres o más>
AUTH_SESSION_SECRET=<otro secreto aleatorio de 32 caracteres o más>
TELEGRAM_BOT_TOKEN=<token entregado por BotFather>
TELEGRAM_CHAT_ID=<identificador numérico del grupo>
AUTH_COOKIE_SECURE=true
```

Los dos secretos deben ser distintos. Se pueden generar, por ejemplo, con
`openssl rand -hex 32`. No deben guardarse en Git ni mostrarse en logs.

Opciones adicionales:

```text
AUTH_CODE_DIGITS=8
AUTH_CODE_PERIOD_SECONDS=30
AUTH_CODE_GRACE_SECONDS=5
AUTH_SESSION_HOURS=12
AUTH_ATTEMPTS_LIMIT=6
AUTH_ATTEMPTS_WINDOW_SECONDS=600
AUTH_LOCK_SECONDS=600
AUTH_TIME_ZONE=Europe/Madrid
AUTH_TRUST_PROXY=loopback, linklocal, uniquelocal
```

`AUTH_COOKIE_SECURE` sólo debe ponerse a `false` durante pruebas locales por HTTP.
En producción el dashboard debe publicarse exclusivamente mediante HTTPS.

## Proteger otras rutas de Nginx

El middleware incluido protege el dashboard y su API. Los demás servicios que Nginx
envía directamente a otros contenedores deben usar el endpoint interno
`/_auth/check` mediante `auth_request`, para que no puedan saltarse el login:

```nginx
location = /_auth/check {
    internal;
    proxy_pass http://homelab-dashboard:3000/_auth/check;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}

# Dentro de cada location protegida:
auth_request /_auth/check;
error_page 401 =302 /login;
```

La ruta `/login` y sus recursos deben quedar fuera de ese `auth_request`.

## Revocación

Al expulsar a alguien del grupo dejará de recibir códigos nuevos. Una sesión ya
iniciada seguirá activa hasta su caducidad. Para cerrar todas las sesiones de forma
inmediata, cambia `AUTH_SESSION_SECRET` y reinicia el contenedor.
