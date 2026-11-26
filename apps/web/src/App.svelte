<main>
  <h1>Klaxon</h1>
</main>

<style>
  :global(html) {
    color-scheme: dark;
    background: #0a0a0a;
    color: #f0eee6;
    font-family: system-ui, sans-serif;
  }

  :global(body) {
    margin: 0;
  }

  main {
    box-sizing: border-box;
    display: grid;
    min-height: 100vh;
    min-height: 100svh;
    padding: 2rem;
    place-items: center;
  }

  h1 {
    border-inline-start: 0.25rem solid #ff9d00;
    margin: 0;
    padding-inline-start: clamp(1rem, 4vw, 2rem);
    font-size: clamp(3rem, 11vw, 6rem);
    font-weight: 800;
    letter-spacing: -0.06em;
    line-height: 1;
  }
</style>
