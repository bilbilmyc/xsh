"""Run against Vite: python tests/ui-workflows.py [--url http://127.0.0.1:1420]."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:1420")
parser.add_argument("--output", default="output/ux-review")
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
results = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)

    def run(name, case, verify):
        page = browser.new_page(viewport={"width": 1360, "height": 900})
        page.set_default_timeout(5000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(f"{args.url}/tests/workflow-fixture.html?case={case}")
            page.wait_for_load_state("networkidle")
            verify(page)
            assert not errors, errors
            results.append({"name": name, "passed": True})
        except Exception as error:
            results.append({"name": name, "passed": False, "error": str(error)[:900]})
            page.screenshot(path=str(out / f"{case}-failure.png"))
        finally:
            page.close()

    def queued(page):
        expect(page.locator(".rd-pane-header small")).to_contain_text("排队等待连接")
        expect(page.get_by_role("button", name="连接桌面", exact=True)).to_be_disabled()
        assert page.evaluate("window.__qa.connections + window.__qa.desktops") == 0
        page.get_by_role("button", name="分配连接名额").click()
        page.wait_for_function("window.__qa.desktops === 1")

    def disconnect(page):
        expect(page.get_by_role("button", name="断开", exact=True)).to_be_visible()
        page.clock.install()
        page.get_by_role("button", name="断开", exact=True).click()
        page.clock.fast_forward(6500)
        assert page.evaluate("window.__qa.connections") == 1, "manual disconnect restarted SSH"
        expect(page.get_by_role("button", name="重新连接", exact=True)).to_be_enabled()
        page.get_by_role("button", name="重新连接", exact=True).click()
        page.wait_for_function("window.__qa.connections === 2")

    def network_drop(page):
        expect(page.get_by_role("button", name="断开", exact=True)).to_be_visible()
        page.clock.install()
        page.evaluate("window.__qa.drop()")
        page.clock.fast_forward(6500)
        page.wait_for_function("window.__qa.connections === 2")

    def retry_hosts(page):
        expect(page.get_by_text("模拟暂时读取失败", exact=False)).to_be_visible()
        page.get_by_role("button", name="重新读取信任记录").click(timeout=1500)
        expect(page.get_by_text("还没有已信任的服务器。连接并确认指纹后，记录会显示在这里。")).to_be_visible()
        assert page.evaluate("window.__qa.reads") == 2

    def cancel_connecting(page):
        page.get_by_role("button", name="取消连接", exact=True).click()
        expect(page.locator(".rd-pane-header small")).to_contain_text("已断开")
        page.evaluate("window.__qa.finishConnect()")
        page.wait_for_function("window.__qa.disconnects === 1")
        assert page.evaluate("window.__qa.desktops") == 0
        expect(page.locator(".rd-pane-header small")).to_contain_text("已断开")

    def stale_acknowledgement(page):
        expect(page.get_by_role("button", name="断开", exact=True)).to_be_visible()
        page.clock.install()
        page.evaluate("window.__qa.output()")
        page.get_by_role("button", name="断开", exact=True).click()
        page.get_by_role("button", name="重新连接", exact=True).click()
        page.clock.fast_forward(600)
        before = page.evaluate("window.__qa.acknowledgements")
        assert all(item["id"] != "ssh-2" for item in before), "old output acknowledged on the new connection"
        page.evaluate("window.__qa.output()")
        page.clock.fast_forward(600)
        assert page.evaluate("window.__qa.acknowledgements") == before + [{"id": "ssh-2", "bytes": 1024}]

    def themes(page):
        for theme in ["white", "black"]:
            page.locator(f'.theme-choice:has(input[value="{theme}"])').click()
            page.get_by_role("button", name="保存并应用").click()
            page.reload()
            page.wait_for_load_state("networkidle")
            expect(page.locator(f'input[name="xsh-app-theme"][value="{theme}"]')).to_be_checked()
            assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == ("#ffffff" if theme == "white" else "#080808")
            page.get_by_role("button", name="终端", exact=True).click()
            palette = "xsh-white-black" if theme == "white" else "xsh-black-white"
            page.locator(f'.terminal-theme-choice:has(input[value="{palette}"])').click()
            expect(page.get_by_label("终端外观预览")).to_have_css("background-color", "rgb(255, 255, 255)" if theme == "white" else "rgb(0, 0, 0)")
            page.locator(".terminal-theme-grid").evaluate("el => { const page = el.closest('.settings-page'); page.scrollTop += el.getBoundingClientRect().top - page.getBoundingClientRect().top - 42; }")
            page.screenshot(path=str(out / f"terminal-{theme}.png"))
            page.get_by_role("button", name="保存并应用").click()
            page.reload()
            page.wait_for_load_state("networkidle")
            page.get_by_role("button", name="终端", exact=True).click()
            expect(page.locator(f'input[name="xsh-terminal-theme"][value="{palette}"]')).to_be_checked()
            for width in [980, 1050, 1360]:
                page.set_viewport_size({"width": width, "height": 900})
                assert page.locator(".settings-modal").evaluate("el => el.scrollWidth <= el.clientWidth + 1"), width
                assert page.locator(".settings-page").evaluate("el => el.scrollWidth <= el.clientWidth + 1"), width
                expect(page.get_by_role("button", name="保存并应用")).to_be_in_viewport()
            page.get_by_role("button", name="外观", exact=True).click()
        page.get_by_role("button", name="终端", exact=True).click()
        for palette, background in [("xsh-soft-black", "rgb(28, 28, 28)"), ("xsh-paper", "rgb(247, 243, 232)")]:
            page.locator(f'.terminal-theme-choice:has(input[value="{palette}"])').click()
            expect(page.get_by_label("终端外观预览")).to_have_css("background-color", background)
        # Radio choices remain accessible by keyboard, independent of pointer input.
        radio = page.locator('input[name="xsh-terminal-theme"][value="xsh-paper"]')
        radio.focus()
        page.keyboard.press("ArrowLeft")
        expect(page.locator('input[name="xsh-terminal-theme"][value="xsh-soft-black"]')).to_be_checked()

    run("queued direct desktop respects connection slots", "queued-direct", queued)
    run("queued SSH desktop respects connection slots", "queued-ssh", queued)
    run("manual disconnect stays disconnected and can reconnect", "disconnect", disconnect)
    run("unexpected disconnect still reconnects", "network-drop", network_drop)
    run("old output credit never leaks into a reconnected transport", "stale-ack", stale_acknowledgement)
    run("cancel pending SSH discards late connection result", "cancel-connecting", cancel_connecting)
    run("failed trust-list load can retry without closing settings", "security", retry_hosts)
    run("black/white themes persist, preview and fit desktop widths", "appearance", themes)
    browser.close()

print(json.dumps(results, ensure_ascii=False, indent=2))
(out / "workflow-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
raise SystemExit(0 if all(result["passed"] for result in results) else 1)
