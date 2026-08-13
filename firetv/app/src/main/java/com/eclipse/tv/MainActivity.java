package com.eclipse.tv;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
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
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
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
        webView.setBackgroundColor(0xFF08080C);

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
        String value = urlField.getText().toString().trim();
        if (TextUtils.isEmpty(value)) return;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        prefs().edit().putString(KEY_URL, value).apply();
        load(value);
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
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - backPressedAt < 2000) {
            super.onBackPressed();
        } else {
            backPressedAt = now;
            Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show();
        }
    }
}
