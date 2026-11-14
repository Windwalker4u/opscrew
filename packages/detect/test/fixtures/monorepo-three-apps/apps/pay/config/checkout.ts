export function checkoutDefine(env: Record<string, string>) {
  return {
    __CHECKOUT_URL__: JSON.stringify(env.VITE_CHECKOUT_URL),
    __SHOP_ID__: JSON.stringify(env["VITE_SHOP_ID"]),
  };
}
