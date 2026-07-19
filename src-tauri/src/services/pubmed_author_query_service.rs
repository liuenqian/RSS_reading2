use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorQueryPhase {
    Initial,
    Expansion,
}

#[derive(Debug, Default)]
pub struct AuthorQueryEvidence {
    pub target_names: HashSet<String>,
    pub affiliations: HashSet<String>,
    pub coauthors: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum QueryExpression {
    Atom(QueryAtom),
    And(Vec<QueryExpression>),
    Or(Vec<QueryExpression>),
    Not(Box<QueryExpression>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueryAtom {
    raw: String,
    value: String,
    field: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Atom(String),
    And,
    Or,
    Not,
    LeftParen,
    RightParen,
}

#[derive(Debug, Clone)]
struct SignedAtom {
    atom: QueryAtom,
    negated: bool,
}

pub fn validate_author_query(
    query: &str,
    phase: AuthorQueryPhase,
    evidence: &AuthorQueryEvidence,
) -> Result<(), String> {
    let expression = Parser::new(tokenize(query)?).parse()?;
    let paths = expand_paths(&expression, false)?;
    for path in paths {
        validate_path(&path, phase, evidence)?;
    }
    Ok(())
}

fn validate_path(
    path: &[SignedAtom],
    phase: AuthorQueryPhase,
    evidence: &AuthorQueryEvidence,
) -> Result<(), String> {
    let target_atoms = path
        .iter()
        .filter(|item| !item.negated && is_target_author(&item.atom, evidence))
        .collect::<Vec<_>>();
    if target_atoms.is_empty() {
        return Err("每条 OR 路径都必须包含目标作者姓名".to_string());
    }

    for item in path.iter().filter(|item| item.negated) {
        if is_target_author(&item.atom, evidence)
            || is_known_affiliation(&item.atom, evidence)
            || is_known_coauthor(&item.atom, evidence)
        {
            return Err("NOT 不能排除已确认的作者身份词".to_string());
        }
    }

    if target_atoms
        .iter()
        .any(|item| is_initial_author(&item.atom))
    {
        let has_affiliation = path
            .iter()
            .any(|item| !item.negated && is_known_affiliation(&item.atom, evidence));
        let has_coauthor = phase == AuthorQueryPhase::Expansion
            && path
                .iter()
                .any(|item| !item.negated && is_known_coauthor(&item.atom, evidence));
        if !has_affiliation && !has_coauthor {
            return Err("目标作者首字母写法必须与同路径的单位或稳定共同作者联合".to_string());
        }
    }
    Ok(())
}

fn is_target_author(atom: &QueryAtom, evidence: &AuthorQueryEvidence) -> bool {
    is_author_field(&atom.field) && evidence.target_names.contains(&normalize_term(&atom.value))
}

fn is_known_affiliation(atom: &QueryAtom, evidence: &AuthorQueryEvidence) -> bool {
    let field = atom.field.to_ascii_lowercase();
    (field == "affiliation" || field.starts_with("affiliation:"))
        && evidence.affiliations.contains(&normalize_term(&atom.value))
}

fn is_known_coauthor(atom: &QueryAtom, evidence: &AuthorQueryEvidence) -> bool {
    atom.field.eq_ignore_ascii_case("author")
        && evidence.coauthors.contains(&normalize_term(&atom.value))
}

fn is_author_field(field: &str) -> bool {
    field.eq_ignore_ascii_case("author") || field.eq_ignore_ascii_case("full author name")
}

fn is_initial_author(atom: &QueryAtom) -> bool {
    if atom.field.eq_ignore_ascii_case("full author name") {
        return false;
    }
    let parts = normalize_term(&atom.value)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    parts.len() == 2 && (parts[0].chars().count() <= 2 || parts[1].chars().count() <= 2)
}

fn normalize_term(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn expand_paths(
    expression: &QueryExpression,
    negated: bool,
) -> Result<Vec<Vec<SignedAtom>>, String> {
    match expression {
        QueryExpression::Atom(atom) => Ok(vec![vec![SignedAtom {
            atom: atom.clone(),
            negated,
        }]]),
        QueryExpression::Not(child) => expand_paths(child, !negated),
        QueryExpression::And(children) if !negated => combine_paths(children, false),
        QueryExpression::Or(children) if negated => combine_paths(children, true),
        QueryExpression::Or(children) => append_paths(children, false),
        QueryExpression::And(children) => append_paths(children, true),
    }
}

fn combine_paths(
    children: &[QueryExpression],
    negated: bool,
) -> Result<Vec<Vec<SignedAtom>>, String> {
    let mut combined = vec![Vec::new()];
    for child in children {
        let child_paths = expand_paths(child, negated)?;
        let mut next = Vec::new();
        for left in &combined {
            for right in &child_paths {
                let mut path = left.clone();
                path.extend(right.iter().cloned());
                next.push(path);
                if next.len() > 64 {
                    return Err("作者检索式布尔路径超过 64 条，请简化查询".to_string());
                }
            }
        }
        combined = next;
    }
    Ok(combined)
}

fn append_paths(
    children: &[QueryExpression],
    negated: bool,
) -> Result<Vec<Vec<SignedAtom>>, String> {
    let mut paths = Vec::new();
    for child in children {
        paths.extend(expand_paths(child, negated)?);
        if paths.len() > 64 {
            return Err("作者检索式布尔路径超过 64 条，请简化查询".to_string());
        }
    }
    Ok(paths)
}

fn tokenize(query: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < query.len() {
        index = skip_whitespace(query, index);
        if index >= query.len() {
            break;
        }
        let character = query[index..].chars().next().unwrap();
        if character == '(' {
            tokens.push(Token::LeftParen);
            index += character.len_utf8();
            continue;
        }
        if character == ')' {
            tokens.push(Token::RightParen);
            index += character.len_utf8();
            continue;
        }
        if let Some((token, end)) = boolean_token(query, index) {
            tokens.push(token);
            index = end;
            continue;
        }

        let start = index;
        let mut quoted = false;
        let mut bracket_depth = 0usize;
        while index < query.len() {
            let current = query[index..].chars().next().unwrap();
            if current == '"' && bracket_depth == 0 {
                quoted = !quoted;
            } else if !quoted && current == '[' {
                bracket_depth += 1;
            } else if !quoted && current == ']' {
                bracket_depth = bracket_depth.saturating_sub(1);
            } else if !quoted && bracket_depth == 0 && matches!(current, '(' | ')') {
                break;
            } else if !quoted && bracket_depth == 0 && current.is_whitespace() {
                let next = skip_whitespace(query, index);
                let next_is_parenthesis = query[next..]
                    .chars()
                    .next()
                    .is_some_and(|character| matches!(character, '(' | ')'));
                if next >= query.len()
                    || next_is_parenthesis
                    || boolean_token(query, next).is_some()
                {
                    break;
                }
            }
            index += current.len_utf8();
        }
        if quoted || bracket_depth != 0 {
            return Err("作者检索式的引号或字段标签未闭合".to_string());
        }
        let atom = query[start..index].trim();
        if atom.is_empty() {
            return Err("作者检索式包含空词条".to_string());
        }
        tokens.push(Token::Atom(atom.to_string()));
    }
    if tokens.is_empty() {
        return Err("作者检索式不能为空".to_string());
    }
    Ok(tokens)
}

fn skip_whitespace(value: &str, mut index: usize) -> usize {
    while index < value.len() {
        let character = value[index..].chars().next().unwrap();
        if !character.is_whitespace() {
            break;
        }
        index += character.len_utf8();
    }
    index
}

fn boolean_token(value: &str, index: usize) -> Option<(Token, usize)> {
    for (keyword, token) in [("AND", Token::And), ("OR", Token::Or), ("NOT", Token::Not)] {
        let end = index.checked_add(keyword.len())?;
        if end > value.len() || !value[index..end].eq_ignore_ascii_case(keyword) {
            continue;
        }
        let boundary = value[end..]
            .chars()
            .next()
            .is_none_or(|character| character.is_whitespace() || matches!(character, '(' | ')'));
        if boundary {
            return Some((token, end));
        }
    }
    None
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            position: 0,
        }
    }

    fn parse(mut self) -> Result<QueryExpression, String> {
        let expression = self.parse_or()?;
        if self.position != self.tokens.len() {
            return Err("作者检索式包含缺少布尔操作符的词条".to_string());
        }
        Ok(expression)
    }

    fn parse_or(&mut self) -> Result<QueryExpression, String> {
        let mut children = vec![self.parse_and()?];
        while self.consume(&Token::Or) {
            children.push(self.parse_and()?);
        }
        Ok(if children.len() == 1 {
            children.remove(0)
        } else {
            QueryExpression::Or(children)
        })
    }

    fn parse_and(&mut self) -> Result<QueryExpression, String> {
        let mut children = vec![self.parse_not()?];
        while self.consume(&Token::And) {
            children.push(self.parse_not()?);
        }
        Ok(if children.len() == 1 {
            children.remove(0)
        } else {
            QueryExpression::And(children)
        })
    }

    fn parse_not(&mut self) -> Result<QueryExpression, String> {
        if self.consume(&Token::Not) {
            return Ok(QueryExpression::Not(Box::new(self.parse_not()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<QueryExpression, String> {
        match self.tokens.get(self.position).cloned() {
            Some(Token::Atom(raw)) => {
                self.position += 1;
                Ok(QueryExpression::Atom(parse_atom(&raw)?))
            }
            Some(Token::LeftParen) => {
                self.position += 1;
                let expression = self.parse_or()?;
                if !self.consume(&Token::RightParen) {
                    return Err("作者检索式括号未闭合".to_string());
                }
                Ok(expression)
            }
            _ => Err("作者检索式缺少查询词条".to_string()),
        }
    }

    fn consume(&mut self, expected: &Token) -> bool {
        if self.tokens.get(self.position) == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

fn parse_atom(raw: &str) -> Result<QueryAtom, String> {
    let field_start = raw
        .rfind('[')
        .ok_or_else(|| format!("作者检索词缺少 PubMed 字段标签: {raw}"))?;
    if !raw.ends_with(']') {
        return Err(format!("作者检索词字段标签未闭合: {raw}"));
    }
    let value = raw[..field_start].trim().trim_matches('"').trim();
    let field = raw[field_start + 1..raw.len() - 1].trim();
    if value.is_empty() || field.is_empty() {
        return Err(format!("作者检索词或字段不能为空: {raw}"));
    }
    if field.to_ascii_lowercase().contains("date") {
        return Err("AI 作者候选中不能自行加入日期字段".to_string());
    }
    Ok(QueryAtom {
        raw: raw.to_string(),
        value: value.to_string(),
        field: field.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initial_evidence() -> AuthorQueryEvidence {
        AuthorQueryEvidence {
            target_names: ["lyu lingchun", "lyu l"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            affiliations: ["lishui central hospital"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            coauthors: HashSet::new(),
        }
    }

    #[test]
    fn accepts_full_name_or_affiliation_constrained_initials() {
        let query = "\"Lyu Lingchun\"[Full Author Name] OR (Lyu L[Author] AND \"Lishui Central Hospital\"[Affiliation])";

        validate_author_query(query, AuthorQueryPhase::Initial, &initial_evidence()).unwrap();
    }

    #[test]
    fn rejects_any_or_path_with_unconstrained_initials() {
        let query = "\"Lyu Lingchun\"[Full Author Name] OR Lyu L[Author] OR (Lyu L[Author] AND \"Lishui Central Hospital\"[Affiliation])";

        assert!(
            validate_author_query(query, AuthorQueryPhase::Initial, &initial_evidence())
                .unwrap_err()
                .contains("首字母")
        );
    }

    #[test]
    fn rejects_affiliation_only_paths_and_negative_constraints() {
        let evidence = initial_evidence();
        let affiliation_only =
            "\"Lyu Lingchun\"[Full Author Name] OR \"Lishui Central Hospital\"[Affiliation]";
        let negative = "Lyu L[Author] AND NOT \"Lishui Central Hospital\"[Affiliation]";

        assert!(
            validate_author_query(affiliation_only, AuthorQueryPhase::Initial, &evidence)
                .unwrap_err()
                .contains("目标作者")
        );
        assert!(
            validate_author_query(negative, AuthorQueryPhase::Initial, &evidence)
                .unwrap_err()
                .contains("NOT")
        );
    }

    #[test]
    fn only_expansion_allows_initials_constrained_by_known_coauthor() {
        let mut evidence = initial_evidence();
        evidence.coauthors.insert("zhang s".to_string());
        let query = "Lyu L[Author] AND Zhang S[Author]";

        assert!(validate_author_query(query, AuthorQueryPhase::Initial, &evidence).is_err());
        validate_author_query(query, AuthorQueryPhase::Expansion, &evidence).unwrap();
    }

    #[test]
    fn rejects_ai_supplied_date_fields() {
        let query = "\"Lyu Lingchun\"[Full Author Name] AND 2020:2026[Date - Publication]";

        assert!(
            validate_author_query(query, AuthorQueryPhase::Initial, &initial_evidence())
                .unwrap_err()
                .contains("日期")
        );
    }
}
