package com.eclipse.tv;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * A TV-shaped shell around the ECLIPSE web client: a WebView pointed at
 * whatever server address the household typed in once, full screen, with the
 * system bars out of the way and fullscreen video wired through properly.
 * There's deliberately no more to it than that — the server already renders
 * a complete interface, this just gives it an icon on the Fire TV home screen.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "eclipse";
    private static final String KEY_URL = "server_url";

    private WebView webView;
    private View setupView;
    private EditText urlField;
    private TextView errorText;
    private FrameLayout root;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private long backPressedAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);
        hideSystemBars();

        root = findViewById(R.id.root);
        webView = findViewById(R.id.webview);
        setupView = findViewById(R.id.setup);
        urlField = findViewById(R.id.url_field);
        errorText = findViewById(R.id.error_text);
        Button connect = findViewById(R.id.connect_button);

        configureWebView();

        connect.setOnClickListener(v -> tryConnect());
        urlField.setOnEditorActionListener((v, actionId, event) -> {
            tryConnect();
            return true;
        });

        String saved = prefs().getString(KEY_URL, null);
        if (!TextUtils.isEmpty(saved)) {
            load(saved);
        } else {
            showSetup();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void hideSystemBars() {
        // The legacy systemUiVisibility flags are deprecated as of API 30 and
        // can leave a sliver of system bar showing on newer Fire OS builds
        // (Fire OS 8 is Android 11-based) — exactly the kind of thing that
        // would eat into the top of the screen and read as clipped content.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Some Fire OS builds otherwise boost text scale for "readability,"
        // which is exactly what pushes hero content taller than the screen.
        // (setInitialScale() is deliberately not used here — it's known to
        // fight with a page's own viewport meta tag on some WebView builds,
        // which would work against width=device-width rather than help it.)
        settings.setTextZoom(100);
        // The page's only signal that it's running here, not in a browser
        // — see index.html's inline detector script.
        settings.setUserAgentString(settings.getUserAgentString() + " ECLIPSE-TV/1.0");
        webView.setBackgroundColor(0xFF08080C);
        // This is Android's own scrollbar chrome, layered on top of the page —
        // no CSS on the page side can touch it, which is why hiding it there
        // wasn't enough. The web client already glides the page itself; a
        // native scrollbar overlay on top of that just reads as "this is a
        // scrolled webview," the opposite of the effect the glide is for.
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false; // stay inside the app — the server is the whole interface
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                runOnUiThread(() -> {
                    showSetup();
                    errorText.setText("Couldn't reach that address — " + description);
                    errorText.setVisibility(View.VISIBLE);
                });
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // The player uses the browser Fullscreen API for its own fullscreen
            // control; without these two callbacks the WebView just ignores that
            // request instead of actually taking over the screen.
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                webView.setVisibility(View.GONE);
                root.addView(customView, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideSystemBars();
            }

            @Override
            public void onHideCustomView() {
                removeCustomView();
            }
        });
    }

    private void removeCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        customViewCallback = null;
        webView.setVisibility(View.VISIBLE);
        hideSystemBars();
    }

    private void tryConnect() {
        // Neither submit path (the on-screen keyboard's Done action, or
        // clicking Connect with the remote while the field still has real
        // focus) makes Android dismiss its own soft keyboard on its own —
        // hiding the WebView underneath it doesn't touch the IME, which is
        // still attached to a EditText that's merely invisible now, not
        // blurred. Left alone, that's a keyboard sitting on top of the
        // player/library with nothing on screen to dismiss it, which is
        // what "have to press Home and come back" was actually working
        // around.
        hideKeyboard();

        String value = urlField.getText().toString().trim();
        if (TextUtils.isEmpty(value)) return;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        prefs().edit().putString(KEY_URL, value).apply();
        load(value);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlField.getWindowToken(), 0);
    }

    private void load(String url) {
        errorText.setVisibility(View.GONE);
        setupView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void showSetup() {
        webView.setVisibility(View.GONE);
        setupView.setVisibility(View.VISIBLE);
        urlField.requestFocus();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU && setupView.getVisibility() != View.VISIBLE) {
            showSetup();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            WebChromeClient.CustomViewCallback cb = customViewCallback;
            removeCustomView();
            if (cb != null) cb.onCustomViewHidden();
            return;
        }
        if (setupView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        // The player, search and N.O.V.A. are DOM overlays with no history
        // entry of their own — a hardware Back press never reaches their
        // keyboard Escape handlers, so ask the page directly whether it has
        // something open to close before touching page history or exiting.
        webView.evaluateJavascript(
                "(function(){try{return !!(window.eclipseTvBack && window.eclipseTvBack());}catch(e){return false;}})();",
                (String result) -> {
                    if ("true".equals(result)) return;
                    if (webView.canGoBack()) {
                        webView.goBack();
                        return;
                    }
                    long now = System.currentTimeMillis();
                    if (now - backPressedAt < 2000) {
                        super.onBackPressed();
                    } else {
                        backPressedAt = now;
                        Toast.makeText(MainActivity.this, "Press back again to exit", Toast.LENGTH_SHORT).show();
                    }
                });
    }
}
