use serde_json::Value;

const HIDDEN_KEY: &str = "[已隐藏 API Key]";

#[derive(Default)]
pub(super) struct EventStream {
    line: Vec<u8>,
    data: String,
    finished: bool,
    done: bool,
}

impl EventStream {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        let mut output = Vec::new();
        for byte in bytes {
            if self.done {
                break;
            }
            if *byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                let line =
                    std::str::from_utf8(&self.line).map_err(|_| "AI 流式回复包含无效 UTF-8")?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        let data = std::mem::take(&mut self.data);
                        self.event(data.trim_end_matches('\n'), &mut output)?;
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                    self.data.push('\n');
                }
                self.line.clear();
            } else {
                self.line.push(*byte);
            }
        }
        Ok(output)
    }

    fn event(&mut self, data: &str, output: &mut Vec<String>) -> Result<(), String> {
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let payload: Value =
            serde_json::from_str(data).map_err(|_| "AI 服务返回了无效的流式 JSON")?;
        if payload.get("error").is_some() {
            return Err("AI 服务中途返回错误，请检查服务状态后重试".into());
        }
        let choices = payload
            .get("choices")
            .and_then(Value::as_array)
            .ok_or("AI 服务未返回 Chat Completions 流式格式")?;
        for choice in choices {
            if choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                continue;
            }
            if let Some(delta) = choice.get("delta") {
                reject_tools(delta)?;
                if let Some(content) = delta.get("content").filter(|value| !value.is_null()) {
                    let content = content.as_str().ok_or("AI 当前仅支持文本回复")?;
                    if self.finished && !content.is_empty() {
                        return Err("AI 服务在结束后继续返回正文，请检查服务协议".into());
                    }
                    if !content.is_empty() {
                        output.push(content.to_owned());
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").filter(|value| !value.is_null()) {
                validate_finish_reason(reason)?;
                self.finished = true;
            }
        }
        Ok(())
    }

    pub(super) fn is_done(&self) -> bool {
        self.done
    }

    pub(super) fn finish(self) -> Result<(), String> {
        if self.done || (self.finished && self.line.is_empty() && self.data.is_empty()) {
            Ok(())
        } else {
            Err("AI 流式连接提前结束，回复不完整；请重新发送".into())
        }
    }
}

fn reject_tools(value: &Value) -> Result<(), String> {
    if value
        .get("tool_calls")
        .is_some_and(|tools| !tools.is_null())
        || value
            .get("function_call")
            .is_some_and(|call| !call.is_null())
    {
        return Err("AI 服务返回了工具调用；XSH 只支持文本和待确认的命令草稿".into());
    }
    Ok(())
}

fn validate_finish_reason(reason: &Value) -> Result<(), String> {
    match reason.as_str() {
        Some("stop") => Ok(()),
        Some("length") => Err("AI 回复达到服务长度限制，内容不完整；请缩短问题后重试".into()),
        Some("content_filter") => Err("AI 回复被服务过滤，内容不完整".into()),
        _ => Err("AI 回复未正常结束；XSH 不执行工具调用，请重试文本请求".into()),
    }
}

pub(super) fn json_content(bytes: &[u8]) -> Result<String, String> {
    let payload: Value =
        serde_json::from_slice(bytes).map_err(|_| "AI 服务未返回有效的 Chat Completions JSON")?;
    let choice = payload
        .pointer("/choices/0")
        .ok_or("AI 服务未返回文本回复；当前仅支持 Chat Completions 文本协议")?;
    let message = choice.get("message").ok_or("AI 服务未返回文本回复")?;
    reject_tools(message)?;
    if let Some(reason) = choice.get("finish_reason").filter(|value| !value.is_null()) {
        validate_finish_reason(reason)?;
    }
    message
        .get("content")
        .and_then(Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "AI 服务未返回文本回复；当前仅支持 Chat Completions 文本协议".into())
}

pub(super) struct KeyShield {
    secret: Option<zeroize::Zeroizing<String>>,
    pending: String,
}

impl KeyShield {
    pub(super) fn new(secret: Option<zeroize::Zeroizing<String>>) -> Self {
        Self {
            secret: secret.filter(|secret| !secret.is_empty()),
            pending: String::new(),
        }
    }

    pub(super) fn push(&mut self, text: &str) -> String {
        let Some(secret) = self.secret.as_ref() else {
            return text.to_owned();
        };
        self.pending.push_str(text);
        let mut safe = String::new();
        while let Some(position) = self.pending.find(secret.as_str()) {
            safe.push_str(&self.pending[..position]);
            safe.push_str(HIDDEN_KEY);
            self.pending.drain(..position + secret.len());
        }
        let carry = (1..secret.len().min(self.pending.len() + 1))
            .rev()
            .find(|length| {
                self.pending.is_char_boundary(self.pending.len() - length)
                    && secret.is_char_boundary(*length)
                    && self.pending.as_bytes()[self.pending.len() - length..]
                        == secret.as_bytes()[..*length]
            })
            .unwrap_or(0);
        safe.push_str(&self.pending[..self.pending.len() - carry]);
        self.pending.drain(..self.pending.len() - carry);
        safe
    }

    pub(super) fn finish(self) -> String {
        self.pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(content: &str) -> String {
        format!(
            "data: {}\r\n\r\n",
            serde_json::json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":null}]})
        )
    }

    #[test]
    fn sse_handles_every_byte_boundary_utf8_crlf_comments_and_usage() {
        let stream = format!(
            ": keepalive\r\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\"}}}}]}}\r\n\r\n{}{}data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\r\n\r\ndata: {{\"choices\":[],\"usage\":{{}}}}\r\n\r\ndata: [DONE]\r\n\r\n",
            chunk("检查目录"),
            chunk("权限🙂")
        );
        for boundary in 1..stream.len() {
            let mut parser = EventStream::default();
            let mut output = parser.push(&stream.as_bytes()[..boundary]).unwrap();
            output.extend(parser.push(&stream.as_bytes()[boundary..]).unwrap());
            assert_eq!(output.concat(), "检查目录权限🙂");
            assert!(parser.is_done());
            parser.finish().unwrap();
        }
    }

    #[test]
    fn sse_supports_multiple_data_lines_and_explicit_stop_without_done() {
        let mut parser = EventStream::default();
        let output = parser
            .push(b"data: {\"choices\":[\ndata: {\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
            .unwrap();
        assert_eq!(output, ["ok"]);
        parser.finish().unwrap();
    }

    #[test]
    fn sse_rejects_eof_invalid_utf8_tool_calls_and_truncation() {
        let mut parser = EventStream::default();
        parser.push(chunk("partial").as_bytes()).unwrap();
        assert!(parser.finish().is_err());
        for source in [
            b"data: \xff\n\n".as_slice(),
            b"data: not-json\n\n".as_slice(),
            b"data: {\"error\":{\"message\":\"private\"}}\n\n".as_slice(),
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[]}}]}\n\n".as_slice(),
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".as_slice(),
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n"
                .as_slice(),
        ] {
            assert!(EventStream::default().push(source).is_err());
        }
    }

    #[test]
    fn key_shield_hides_keys_across_every_delta_boundary_before_emitting() {
        for secret in ["test-secret-key", "测试密钥🙂", "abab"] {
            let content = format!("before {secret} middle {secret} after");
            for boundary in content
                .char_indices()
                .map(|(position, _)| position)
                .chain([content.len()])
            {
                let mut shield = KeyShield::new(Some(zeroize::Zeroizing::new(secret.into())));
                let first = shield.push(&content[..boundary]);
                let second = shield.push(&content[boundary..]);
                let output = format!("{first}{second}{}", shield.finish());
                assert!(!first.contains(secret));
                assert!(!second.contains(secret));
                assert_eq!(
                    output,
                    "before [已隐藏 API Key] middle [已隐藏 API Key] after"
                );
            }
        }
    }

    #[test]
    fn key_shield_never_emits_a_possible_key_prefix_before_next_delta() {
        let mut shield = KeyShield::new(Some(zeroize::Zeroizing::new("secret-key".into())));
        assert_eq!(shield.push("ok sec"), "ok ");
        assert_eq!(shield.push("ret-"), "");
        assert_eq!(shield.push("key done"), "[已隐藏 API Key] done");
        assert_eq!(shield.finish(), "");
    }

    #[test]
    fn json_fallback_accepts_only_text_with_normal_finish() {
        assert_eq!(
            json_content(br#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#)
                .unwrap(),
            "ok"
        );
        for body in [
            br#"{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}"#
                .as_slice(),
            br#"{"choices":[{"message":{"content":"bad","tool_calls":[]}}]}"#.as_slice(),
            b"private-invalid-json".as_slice(),
        ] {
            assert!(json_content(body).is_err());
        }
    }
}
